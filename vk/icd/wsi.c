// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// kwvk: surfaces (VkIcdSurface* layout), swapchains and
// present. Wayland presents without pixels where the compositor is the
// page's wland and the host resolves its ids (external buffers: one
// wl_buffer per swapchain image, named by the host's token and the image's
// export id), else by reading the image back from the host into a wl_shm
// buffer; both on a private event queue of the app's wl_display. X11 (xcb
// or Xlib surfaces) presents by xcb_put_image; libwayland-client and
// libxcb are dlopen'ed, so the ICD has no link-time dependency. Headless
// presents without readback.
#include "kwvk.h"

#include <dlfcn.h>
#include <poll.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>

#define API VKAPI_ATTR
#define CALL VKAPI_CALL

/* ---- libwayland-client, by hand ---- */

struct wl_proxy;
struct wl_display;
struct wl_event_queue;
struct wl_interface;

static struct {
	int loaded;
	struct wl_proxy *(*marshal_flags)(struct wl_proxy *, uint32_t, const struct wl_interface *, uint32_t, uint32_t, ...);
	int (*add_listener)(struct wl_proxy *, void (**)(void), void *);
	void (*proxy_destroy)(struct wl_proxy *);
	uint32_t (*get_version)(struct wl_proxy *);
	void *(*create_wrapper)(void *);
	void (*wrapper_destroy)(void *);
	void (*set_queue)(struct wl_proxy *, struct wl_event_queue *);
	struct wl_event_queue *(*create_queue)(struct wl_display *);
	void (*queue_destroy)(struct wl_event_queue *);
	int (*roundtrip_queue)(struct wl_display *, struct wl_event_queue *);
	int (*dispatch_queue_pending)(struct wl_display *, struct wl_event_queue *);
	int (*prepare_read_queue)(struct wl_display *, struct wl_event_queue *);
	int (*read_events)(struct wl_display *);
	void (*cancel_read)(struct wl_display *);
	int (*flush)(struct wl_display *);
	int (*get_fd)(struct wl_display *);
	const struct wl_interface *registry_if, *shm_if, *shm_pool_if, *buffer_if, *callback_if;
} wl;

static int wl_load(void)
{
	if (wl.loaded)
		return wl.loaded > 0;
	void *h = dlopen("libwayland-client.so.0", RTLD_NOW | RTLD_GLOBAL);
	wl.loaded = -1;
	if (!h) {
		kw_log("no libwayland-client.so.0: %s", dlerror());
		return 0;
	}
#define S(f, n)                                  \
	*(void **)&wl.f = dlsym(h, n);           \
	if (!wl.f) {                             \
		kw_log("libwayland-client: no %s", n); \
		return 0;                        \
	}
	S(marshal_flags, "wl_proxy_marshal_flags");
	S(add_listener, "wl_proxy_add_listener");
	S(proxy_destroy, "wl_proxy_destroy");
	S(get_version, "wl_proxy_get_version");
	S(create_wrapper, "wl_proxy_create_wrapper");
	S(wrapper_destroy, "wl_proxy_wrapper_destroy");
	S(set_queue, "wl_proxy_set_queue");
	S(create_queue, "wl_display_create_queue");
	S(queue_destroy, "wl_event_queue_destroy");
	S(roundtrip_queue, "wl_display_roundtrip_queue");
	S(dispatch_queue_pending, "wl_display_dispatch_queue_pending");
	S(prepare_read_queue, "wl_display_prepare_read_queue");
	S(read_events, "wl_display_read_events");
	S(cancel_read, "wl_display_cancel_read");
	S(flush, "wl_display_flush");
	S(get_fd, "wl_display_get_fd");
	S(registry_if, "wl_registry_interface");
	S(shm_if, "wl_shm_interface");
	S(shm_pool_if, "wl_shm_pool_interface");
	S(buffer_if, "wl_buffer_interface");
	S(callback_if, "wl_callback_interface");
#undef S
	wl.loaded = 1;
	return 1;
}

/* the interface's name is its first member */
static const char *if_name(const struct wl_interface *i) { return *(const char *const *)i; }

/* wland_external_buffer_manager_v1, version 1, written out by hand as
 * wayland-scanner would from wland's protocol/wland-external-buffer-v1.xml
 * (https://github.com/pithings/wland, MPL-2.0; only the interface's names
 * and signatures are used here): wl_buffers named by an opaque 64-bit id
 * that the page's embedder resolves, no fd and no pixels. Requests:
 * destroy (0), create_buffer (1: new_id wl_buffer, id_hi, id_lo, width,
 * height, format as a DRM fourcc, flags); no events. */
struct kw_wl_message {
	const char *name, *signature;
	const struct wl_interface **types;
};
struct kw_wl_interface {
	const char *name;
	int version, method_count;
	const struct kw_wl_message *methods;
	int event_count;
	const struct kw_wl_message *events;
};
static const struct wl_interface *ext_types[7]; /* [0] = wl_buffer_interface, at wl_setup */
static const struct kw_wl_message ext_methods[] = {{"destroy", "", ext_types}, {"create_buffer", "nuuiiuu", ext_types}};
static const struct kw_wl_interface ext_iface = {"wland_external_buffer_manager_v1", 1, 2, ext_methods, 0, NULL};
#define EXT_IF ((const struct wl_interface *)&ext_iface)
#define DRM_ARGB8888 0x34325241u /* 'AR24': B, G, R, A in memory (B8G8R8A8), premultiplied */
#define DRM_XRGB8888 0x34325258u /* 'XR24': opaque */

/* ---- libxcb (and libX11-xcb for Xlib surfaces), by hand ---- */

struct kw_xcb_surface { /* VkIcdSurfaceXcb */
	VkIcdSurfaceBase base;
	void *connection;
	uint32_t window;
};
struct kw_xlib_surface { /* VkIcdSurfaceXlib */
	VkIcdSurfaceBase base;
	void *dpy;
	unsigned long window;
};
struct kw_xcb_create_info { /* VkXcbSurfaceCreateInfoKHR */
	VkStructureType sType;
	const void *pNext;
	VkFlags flags;
	void *connection;
	uint32_t window;
};
struct kw_xlib_create_info { /* VkXlibSurfaceCreateInfoKHR */
	VkStructureType sType;
	const void *pNext;
	VkFlags flags;
	void *dpy;
	unsigned long window;
};
struct xcb_cookie {
	unsigned int sequence;
};
struct xcb_geometry_reply {
	uint8_t response_type, depth;
	uint16_t sequence;
	uint32_t length, root;
	int16_t x, y;
	uint16_t width, height, border_width;
	uint8_t pad0[2];
};

static struct {
	int loaded;
	uint32_t (*generate_id)(void *);
	struct xcb_cookie (*create_gc)(void *, uint32_t, uint32_t, uint32_t, const void *);
	struct xcb_cookie (*free_gc)(void *, uint32_t);
	struct xcb_cookie (*put_image)(void *, uint8_t, uint32_t, uint32_t, uint16_t, uint16_t, int16_t, int16_t, uint8_t, uint8_t, uint32_t, const uint8_t *);
	struct xcb_cookie (*get_geometry)(void *, uint32_t);
	struct xcb_geometry_reply *(*get_geometry_reply)(void *, struct xcb_cookie, void **);
	uint32_t (*max_request)(void *);
	int (*flush)(void *);
	void *(*xlib_conn)(void *);
	struct xcb_cookie (*put_image_checked)(void *, uint8_t, uint32_t, uint32_t, uint16_t, uint16_t, int16_t, int16_t, uint8_t, uint8_t, uint32_t, const uint8_t *);
	uint8_t *(*request_check)(void *, struct xcb_cookie);
} xcb;

static int xcb_load(void)
{
	if (xcb.loaded)
		return xcb.loaded > 0;
	xcb.loaded = -1;
	void *h = dlopen("libxcb.so.1", RTLD_NOW | RTLD_GLOBAL);
	if (!h) {
		kw_log("no libxcb.so.1: %s", dlerror());
		return 0;
	}
#define S(f, n)                                \
	*(void **)&xcb.f = dlsym(h, n);        \
	if (!xcb.f) {                          \
		kw_log("libxcb: no %s", n);    \
		return 0;                      \
	}
	S(generate_id, "xcb_generate_id");
	S(create_gc, "xcb_create_gc");
	S(free_gc, "xcb_free_gc");
	S(put_image, "xcb_put_image");
	S(get_geometry, "xcb_get_geometry");
	S(get_geometry_reply, "xcb_get_geometry_reply");
	S(max_request, "xcb_get_maximum_request_length");
	S(flush, "xcb_flush");
	S(put_image_checked, "xcb_put_image_checked");
	S(request_check, "xcb_request_check");
#undef S
	void *x = dlopen("libX11-xcb.so.1", RTLD_NOW | RTLD_GLOBAL);
	if (x)
		*(void **)&xcb.xlib_conn = dlsym(x, "XGetXCBConnection");
	xcb.loaded = 1;
	return 1;
}

/* the xcb connection and window of an X11 surface */
static int x11_target(VkIcdSurfaceBase *b, void **conn, uint32_t *win)
{
	if (!xcb_load())
		return 0;
	if (b->platform == VK_ICD_WSI_PLATFORM_XCB) {
		struct kw_xcb_surface *s = (void *)b;
		*conn = s->connection;
		*win = s->window;
		return 1;
	}
	if (b->platform == VK_ICD_WSI_PLATFORM_XLIB && xcb.xlib_conn) {
		struct kw_xlib_surface *s = (void *)b;
		*conn = xcb.xlib_conn(s->dpy);
		*win = (uint32_t)s->window;
		return *conn != NULL;
	}
	return 0;
}

static int x11_geometry(VkIcdSurfaceBase *b, uint32_t *w, uint32_t *h, uint8_t *depth)
{
	void *c;
	uint32_t win;
	if (!x11_target(b, &c, &win))
		return 0;
	struct xcb_geometry_reply *r = xcb.get_geometry_reply(c, xcb.get_geometry(c, win), NULL);
	if (!r)
		return 0;
	*w = r->width;
	*h = r->height;
	if (depth)
		*depth = r->depth;
	free(r);
	return 1;
}

/* a round trip on a private queue, as Mesa's WSI does at surface queries:
 * it reads the socket, so the app's default queue gets its pending events
 * (some apps wait for xdg_surface.configure with dispatch_pending alone) */
static void wl_surface_roundtrip(VkIcdSurfaceBase *b)
{
	if (b->platform != VK_ICD_WSI_PLATFORM_WAYLAND || !wl_load())
		return;
	struct wl_display *d = ((VkIcdSurfaceWayland *)b)->display;
	struct wl_event_queue *q = wl.create_queue(d);
	wl.roundtrip_queue(d, q);
	wl.queue_destroy(q);
}

static int is_x11(VkIcdSurfaceBase *b) { return b->platform == VK_ICD_WSI_PLATFORM_XCB || b->platform == VK_ICD_WSI_PLATFORM_XLIB; }

/* ---- surfaces ---- */

static VkIcdSurfaceBase *SURF(VkSurfaceKHR s) { return HANDLE(VkIcdSurfaceBase, s); }

static API VkResult CALL kw_vkGetPhysicalDeviceSurfaceSupportKHR(VkPhysicalDevice pd, uint32_t q, VkSurfaceKHR s, VkBool32 *out)
{
	(void)pd, (void)q;
	VkIcdWsiPlatform p = SURF(s)->platform;
	*out = p == VK_ICD_WSI_PLATFORM_WAYLAND || p == VK_ICD_WSI_PLATFORM_HEADLESS || p == VK_ICD_WSI_PLATFORM_XCB ||
	       p == VK_ICD_WSI_PLATFORM_XLIB;
	return VK_SUCCESS;
}

static API VkBool32 CALL kw_vkGetPhysicalDeviceWaylandPresentationSupportKHR(VkPhysicalDevice pd, uint32_t q, struct wl_display *d)
{
	(void)pd, (void)q, (void)d;
	return VK_TRUE;
}

static API VkResult CALL kw_vkGetPhysicalDeviceSurfaceCapabilitiesKHR(VkPhysicalDevice pdh, VkSurfaceKHR s, VkSurfaceCapabilitiesKHR *c)
{
	struct kw_physical_device *pd = (struct kw_physical_device *)pdh;
	memset(c, 0, sizeof *c);
	c->minImageCount = 2;
	c->maxImageCount = 8;
	c->currentExtent.width = c->currentExtent.height = 0xFFFFFFFFu;
	wl_surface_roundtrip(SURF(s));
	if (is_x11(SURF(s))) {
		uint32_t w, h;
		if (x11_geometry(SURF(s), &w, &h, NULL)) {
			c->currentExtent.width = w;
			c->currentExtent.height = h;
		}
	}
	c->minImageExtent.width = c->minImageExtent.height = 1;
	c->maxImageExtent.width = c->maxImageExtent.height = pd->max2d;
	c->maxImageArrayLayers = 1;
	c->supportedTransforms = VK_SURFACE_TRANSFORM_IDENTITY_BIT_KHR;
	c->currentTransform = VK_SURFACE_TRANSFORM_IDENTITY_BIT_KHR;
	c->supportedCompositeAlpha = VK_COMPOSITE_ALPHA_OPAQUE_BIT_KHR;
	if (SURF(s)->platform == VK_ICD_WSI_PLATFORM_WAYLAND) /* wl_shm ARGB8888 is premultiplied */
		c->supportedCompositeAlpha |= VK_COMPOSITE_ALPHA_PRE_MULTIPLIED_BIT_KHR;
	c->supportedUsageFlags = VK_IMAGE_USAGE_COLOR_ATTACHMENT_BIT | VK_IMAGE_USAGE_TRANSFER_SRC_BIT |
				 VK_IMAGE_USAGE_TRANSFER_DST_BIT | VK_IMAGE_USAGE_SAMPLED_BIT;
	return VK_SUCCESS;
}

static API VkResult CALL kw_vkGetPhysicalDeviceSurfaceFormatsKHR(VkPhysicalDevice pd, VkSurfaceKHR s, uint32_t *n, VkSurfaceFormatKHR *out)
{
	(void)pd;
	wl_surface_roundtrip(SURF(s));
	static const VkSurfaceFormatKHR f[] = {
		{VK_FORMAT_B8G8R8A8_UNORM, VK_COLOR_SPACE_SRGB_NONLINEAR_KHR},
		{VK_FORMAT_B8G8R8A8_SRGB, VK_COLOR_SPACE_SRGB_NONLINEAR_KHR},
	};
	if (!out) {
		*n = 2;
		return VK_SUCCESS;
	}
	uint32_t c = *n < 2 ? *n : 2;
	memcpy(out, f, c * sizeof *out);
	*n = c;
	return c < 2 ? VK_INCOMPLETE : VK_SUCCESS;
}

/* VK_KHR_get_surface_capabilities2 */
static API VkResult CALL kw_vkGetPhysicalDeviceSurfaceCapabilities2KHR(VkPhysicalDevice pd, const VkPhysicalDeviceSurfaceInfo2KHR *i, VkSurfaceCapabilities2KHR *c)
{
	return kw_vkGetPhysicalDeviceSurfaceCapabilitiesKHR(pd, i->surface, &c->surfaceCapabilities);
}

static API VkResult CALL kw_vkGetPhysicalDeviceSurfaceFormats2KHR(VkPhysicalDevice pd, const VkPhysicalDeviceSurfaceInfo2KHR *i, uint32_t *n, VkSurfaceFormat2KHR *out)
{
	if (!out)
		return kw_vkGetPhysicalDeviceSurfaceFormatsKHR(pd, i->surface, n, NULL);
	VkSurfaceFormatKHR f[8];
	uint32_t c = *n < 8 ? *n : 8;
	VkResult r = kw_vkGetPhysicalDeviceSurfaceFormatsKHR(pd, i->surface, &c, f);
	for (uint32_t k = 0; k < c; k++)
		out[k].surfaceFormat = f[k];
	*n = c;
	return r;
}

static API VkResult CALL kw_vkGetPhysicalDeviceSurfacePresentModesKHR(VkPhysicalDevice pd, VkSurfaceKHR s, uint32_t *n, VkPresentModeKHR *out)
{
	(void)pd, (void)s;
	static const VkPresentModeKHR m[] = {VK_PRESENT_MODE_FIFO_KHR, VK_PRESENT_MODE_IMMEDIATE_KHR, VK_PRESENT_MODE_MAILBOX_KHR};
	if (!out) {
		*n = 3;
		return VK_SUCCESS;
	}
	uint32_t c = *n < 3 ? *n : 3;
	memcpy(out, m, c * sizeof *out);
	*n = c;
	return c < 3 ? VK_INCOMPLETE : VK_SUCCESS;
}

/* the ICD makes its own surfaces (newer loaders require it at interface
 * version >= 3), in the VkIcdSurface* layout so a loader-made one works too */
static API VkResult CALL kw_vkCreateWaylandSurfaceKHR(VkInstance i, const VkWaylandSurfaceCreateInfoKHR *ci, const VkAllocationCallbacks *a, VkSurfaceKHR *out)
{
	(void)i, (void)a;
	VkIcdSurfaceWayland *s = calloc(1, sizeof *s);
	s->base.platform = VK_ICD_WSI_PLATFORM_WAYLAND;
	s->display = ci->display;
	s->surface = ci->surface;
	*out = (VkSurfaceKHR)(uintptr_t)s;
	return VK_SUCCESS;
}

static API VkResult CALL kw_vkCreateHeadlessSurfaceEXT(VkInstance i, const VkHeadlessSurfaceCreateInfoEXT *ci, const VkAllocationCallbacks *a, VkSurfaceKHR *out)
{
	(void)i, (void)ci, (void)a;
	VkIcdSurfaceHeadless *s = calloc(1, sizeof *s);
	s->base.platform = VK_ICD_WSI_PLATFORM_HEADLESS;
	*out = (VkSurfaceKHR)(uintptr_t)s;
	return VK_SUCCESS;
}

static API VkResult CALL kw_vkCreateXcbSurfaceKHR(VkInstance i, const struct kw_xcb_create_info *ci, const VkAllocationCallbacks *a, VkSurfaceKHR *out)
{
	(void)i, (void)a;
	struct kw_xcb_surface *s = calloc(1, sizeof *s);
	s->base.platform = VK_ICD_WSI_PLATFORM_XCB;
	s->connection = ci->connection;
	s->window = ci->window;
	*out = (VkSurfaceKHR)(uintptr_t)s;
	return VK_SUCCESS;
}

static API VkResult CALL kw_vkCreateXlibSurfaceKHR(VkInstance i, const struct kw_xlib_create_info *ci, const VkAllocationCallbacks *a, VkSurfaceKHR *out)
{
	(void)i, (void)a;
	struct kw_xlib_surface *s = calloc(1, sizeof *s);
	s->base.platform = VK_ICD_WSI_PLATFORM_XLIB;
	s->dpy = ci->dpy;
	s->window = ci->window;
	*out = (VkSurfaceKHR)(uintptr_t)s;
	return VK_SUCCESS;
}

static API VkBool32 CALL kw_vkGetPhysicalDeviceXcbPresentationSupportKHR(VkPhysicalDevice pd, uint32_t q, void *c, uint32_t v)
{
	(void)pd, (void)q, (void)c, (void)v;
	return VK_TRUE;
}

static API VkBool32 CALL kw_vkGetPhysicalDeviceXlibPresentationSupportKHR(VkPhysicalDevice pd, uint32_t q, void *d, unsigned long v)
{
	(void)pd, (void)q, (void)d, (void)v;
	return VK_TRUE;
}

static API void CALL kw_vkDestroySurfaceKHR(VkInstance i, VkSurfaceKHR s, const VkAllocationCallbacks *a)
{
	(void)i, (void)a;
	free(HANDLE(void, s));
}

/* ---- swapchain ---- */

#define MAXIMG 8
#define MAXBUF 4

struct shmbuf {
	struct wl_proxy *buffer;
	void *map;
	size_t size;
	int busy;
};

struct kw_swapchain {
	struct kw_device *dev;
	VkIcdSurfaceBase *surf;
	VkExtent2D extent;
	VkFormat format;
	VkPresentModeKHR mode;
	VkCompositeAlphaFlagBitsKHR alpha;
	uint32_t n, next;
	struct kw_image imgs[MAXIMG];
	/* wayland */
	struct wl_display *dpy;
	struct wl_proxy *surface, *surface_wrap;
	struct wl_event_queue *queue;
	struct wl_proxy *shm;
	struct shmbuf bufs[MAXBUF];
	uint32_t nbufs;
	struct wl_proxy *frame;
	int wl_ok;
	/* external buffers (wland): one wl_buffer per image, busy from its commit to its release */
	struct wl_proxy *ext; /* the manager, where the compositor offers it */
	int external;
	struct wl_proxy *ebuf[MAXIMG];
	int ebusy[MAXIMG];
	/* x11 */
	void *xconn;
	uint32_t xwin, xgc;
	uint8_t xdepth;
	int xchecked;
};

static void reg_global(void *data, struct wl_proxy *reg, uint32_t name, const char *iface, uint32_t ver)
{
	struct kw_swapchain *sc = data;
	if (!strcmp(iface, "wl_shm") && !sc->shm)
		sc->shm = wl.marshal_flags(reg, 0, wl.shm_if, 1, 0, name, if_name(wl.shm_if), 1u, NULL);
	/* advertised only where wland's embedder resolves external ids (its presence is the signal) */
	if (sc->external && !strcmp(iface, ext_iface.name) && !sc->ext && ver >= 1)
		sc->ext = wl.marshal_flags(reg, 0, EXT_IF, 1, 0, name, ext_iface.name, 1u, NULL);
}
static void reg_remove(void *data, struct wl_proxy *reg, uint32_t name) { (void)data, (void)reg, (void)name; }
static void (*reg_listener[])(void) = {(void (*)(void))reg_global, (void (*)(void))reg_remove};

static void shm_format(void *data, struct wl_proxy *shm, uint32_t f) { (void)data, (void)shm, (void)f; }
static void (*shm_listener[])(void) = {(void (*)(void))shm_format};

static void buf_release(void *data, struct wl_proxy *b)
{
	(void)b;
	((struct shmbuf *)data)->busy = 0;
}
static void (*buf_listener[])(void) = {(void (*)(void))buf_release};

static void ebuf_release(void *data, struct wl_proxy *b)
{
	(void)b;
	*(int *)data = 0;
}
static void (*ebuf_listener[])(void) = {(void (*)(void))ebuf_release};

static void frame_done(void *data, struct wl_proxy *cb, uint32_t t)
{
	(void)t;
	struct kw_swapchain *sc = data;
	if (sc->frame == cb) {
		wl.proxy_destroy(cb);
		sc->frame = NULL;
	}
}
static void (*frame_listener[])(void) = {(void (*)(void))frame_done};

/* reads and dispatches what is on our queue, waiting at most ms */
static void wl_pump(struct kw_swapchain *sc, int ms)
{
	while (wl.prepare_read_queue(sc->dpy, sc->queue) != 0)
		wl.dispatch_queue_pending(sc->dpy, sc->queue);
	wl.flush(sc->dpy);
	struct pollfd p = {wl.get_fd(sc->dpy), POLLIN, 0};
	if (poll(&p, 1, ms) > 0)
		wl.read_events(sc->dpy);
	else
		wl.cancel_read(sc->dpy);
	wl.dispatch_queue_pending(sc->dpy, sc->queue);
}

static int wl_setup(struct kw_swapchain *sc)
{
	VkIcdSurfaceWayland *ws = (VkIcdSurfaceWayland *)sc->surf;
	if (!wl_load())
		return 0;
	ext_types[0] = wl.buffer_if;
	sc->dpy = ws->display;
	sc->surface = (struct wl_proxy *)ws->surface;
	sc->queue = wl.create_queue(sc->dpy);
	struct wl_proxy *dw = wl.create_wrapper(sc->dpy);
	wl.set_queue(dw, sc->queue);
	struct wl_proxy *reg = wl.marshal_flags(dw, 1, wl.registry_if, wl.get_version(dw), 0, NULL);
	wl.wrapper_destroy(dw);
	wl.add_listener(reg, reg_listener, sc);
	wl.roundtrip_queue(sc->dpy, sc->queue);
	wl.proxy_destroy(reg);
	if (!sc->shm) {
		kw_log("compositor has no wl_shm");
		return 0;
	}
	wl.add_listener(sc->shm, shm_listener, sc);
	sc->surface_wrap = wl.create_wrapper(sc->surface);
	wl.set_queue(sc->surface_wrap, sc->queue);
	return 1;
}

static struct shmbuf *wl_buffer_get(struct kw_swapchain *sc, uint32_t w, uint32_t h)
{
	for (int tries = 0;; tries++) {
		for (uint32_t i = 0; i < sc->nbufs; i++)
			if (!sc->bufs[i].busy)
				return &sc->bufs[i];
		if (sc->nbufs < MAXBUF)
			break;
		if (tries >= 4) /* the compositor keeps them all: reuse one rather than hang */
			return &sc->bufs[sc->next % sc->nbufs];
		wl_pump(sc, 25);
	}
	struct shmbuf *b = &sc->bufs[sc->nbufs];
	size_t stride = (size_t)w * 4;
	b->size = stride * h;
	int fd = memfd_create("kwvk-shm", MFD_CLOEXEC);
	if (fd < 0 || ftruncate(fd, (off_t)b->size) < 0) {
		if (fd >= 0)
			close(fd);
		return NULL;
	}
	b->map = mmap(NULL, b->size, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
	if (b->map == MAP_FAILED) {
		close(fd);
		b->map = NULL;
		return NULL;
	}
	struct wl_proxy *pool = wl.marshal_flags(sc->shm, 0, wl.shm_pool_if, wl.get_version(sc->shm), 0, NULL, fd, (int32_t)b->size);
	b->buffer = wl.marshal_flags(pool, 0, wl.buffer_if, wl.get_version(pool), 0, NULL, 0, (int32_t)w, (int32_t)h,
				     (int32_t)stride, sc->alpha == VK_COMPOSITE_ALPHA_PRE_MULTIPLIED_BIT_KHR ? 0u /* ARGB8888 */ : 1u /* XRGB8888 */);
	wl.marshal_flags(pool, 1, NULL, wl.get_version(pool), 1 /* destroy */);
	close(fd);
	wl.add_listener(b->buffer, buf_listener, b);
	sc->nbufs++;
	return b;
}

/* external buffers: one wl_buffer per swapchain image, named by the host's
 * token and the export id it gave the image (vk/PROTOCOL.md, Amendments,
 * "External present"); 0 when the host refuses (wl_shm then) */
static int ext_setup(struct kw_swapchain *sc)
{
	struct kw_device *d = sc->dev;
	struct jb j = {0};
	JS(&j, "{\"op\":\"exportImages\",\"images\":[");
	for (uint32_t i = 0; i < sc->n; i++)
		jb_printf(&j, i ? ",%u" : "%u", sc->imgs[i].id);
	JS(&j, "]}");
	struct kw_reply *rep = link_call(d->link, &j, NULL, 0);
	jb_free(&j);
	const char *ids = rep ? js_get(rep->json, "ids") : NULL;
	if (!ids || *ids != '[') {
		/* a refusal is not a lost device: present by readback */
		char why[256] = "no reply";
		if (rep)
			js_strcpy(js_get(rep->json, "err"), why, sizeof why);
		kw_log("exportImages refused (%s): presenting by readback", why);
		reply_free(rep);
		return 0;
	}
	uint32_t lo[MAXIMG], n = 0;
	for (const char *p = ids + 1; n < sc->n && *p && *p != ']';) {
		while (*p == ' ' || *p == ',')
			p++;
		if (*p == ']' || !*p)
			break;
		lo[n++] = (uint32_t)js_num(p, 0);
		p = js_skip(p);
	}
	reply_free(rep);
	if (n != sc->n) {
		kw_log("exportImages: %u ids for %u images: presenting by readback", n, sc->n);
		return 0;
	}
	uint32_t fourcc = sc->alpha == VK_COMPOSITE_ALPHA_PRE_MULTIPLIED_BIT_KHR ? DRM_ARGB8888 : DRM_XRGB8888;
	for (uint32_t i = 0; i < sc->n; i++) {
		sc->ebuf[i] = wl.marshal_flags(sc->ext, 1, wl.buffer_if, wl.get_version(sc->ext), 0, NULL, d->pd->ext_token, lo[i],
					       (int32_t)sc->extent.width, (int32_t)sc->extent.height, fourcc, 0u /* flags: row 0 at the top */);
		wl.add_listener(sc->ebuf[i], ebuf_listener, &sc->ebusy[i]);
	}
	kw_log("presenting by external buffers (%ux%u, %u images, no readback)", sc->extent.width, sc->extent.height, sc->n);
	return 1;
}

/* before the images go: give the compositor up to 250 ms to release the
 * buffers it holds (no release follows the destruction of a busy one, and
 * the host's image must outlive the commits naming it) */
static void ext_drain(struct kw_swapchain *sc)
{
	if (!sc->external)
		return;
	for (int t = 0; t < 25 && !sc->dev->link->dead; t++) {
		int busy = 0;
		for (uint32_t i = 0; i < sc->n; i++)
			busy |= sc->ebusy[i];
		if (!busy)
			break;
		wl_pump(sc, 10);
	}
}

static void wl_teardown(struct kw_swapchain *sc)
{
	if (!sc->queue)
		return;
	for (uint32_t i = 0; i < sc->n; i++)
		if (sc->ebuf[i])
			wl.marshal_flags(sc->ebuf[i], 0, NULL, wl.get_version(sc->ebuf[i]), 1);
	if (sc->ext)
		wl.marshal_flags(sc->ext, 0, NULL, wl.get_version(sc->ext), 1);
	for (uint32_t i = 0; i < sc->nbufs; i++) {
		wl.marshal_flags(sc->bufs[i].buffer, 0, NULL, wl.get_version(sc->bufs[i].buffer), 1);
		munmap(sc->bufs[i].map, sc->bufs[i].size);
	}
	if (sc->frame)
		wl.proxy_destroy(sc->frame);
	if (sc->shm)
		wl.proxy_destroy(sc->shm);
	if (sc->surface_wrap)
		wl.wrapper_destroy(sc->surface_wrap);
	wl.queue_destroy(sc->queue);
}

static API VkResult CALL kw_vkCreateSwapchainKHR(VkDevice dh, const VkSwapchainCreateInfoKHR *ci, const VkAllocationCallbacks *a, VkSwapchainKHR *out)
{
	(void)a;
	struct kw_device *d = (struct kw_device *)dh;
	struct kw_swapchain *sc = calloc(1, sizeof *sc);
	sc->dev = d;
	sc->surf = SURF(ci->surface);
	sc->extent = ci->imageExtent;
	sc->format = ci->imageFormat;
	sc->mode = ci->presentMode;
	sc->alpha = ci->compositeAlpha;
	sc->n = ci->minImageCount < 2 ? 2 : ci->minImageCount > MAXIMG ? MAXIMG : ci->minImageCount;
	if (is_x11(sc->surf)) {
		uint32_t w, h;
		if (!x11_target(sc->surf, &sc->xconn, &sc->xwin) || !x11_geometry(sc->surf, &w, &h, &sc->xdepth)) {
			free(sc);
			return VK_ERROR_SURFACE_LOST_KHR;
		}
		sc->xgc = xcb.generate_id(sc->xconn);
		xcb.create_gc(sc->xconn, sc->xgc, sc->xwin, 0, NULL);
	}
	if (sc->surf->platform == VK_ICD_WSI_PLATFORM_WAYLAND) {
		/* external buffers where the host resolves them (its hello token) and the
		 * compositor offers them (wl_setup binds the manager); KWVK_EXTERNAL=0 and
		 * KWVK_DUMP (which needs the pixels) keep readback */
		const char *ev = getenv("KWVK_EXTERNAL"), *dump = getenv("KWVK_DUMP");
		sc->external = d->pd->ext_token && !(ev && !strcmp(ev, "0")) && !(dump && *dump) &&
			       (sc->format == VK_FORMAT_B8G8R8A8_UNORM || sc->format == VK_FORMAT_B8G8R8A8_SRGB);
		sc->wl_ok = wl_setup(sc);
		if (!sc->wl_ok) {
			wl_teardown(sc);
			free(sc);
			return VK_ERROR_INITIALIZATION_FAILED;
		}
	}
	VkImageCreateInfo ic = {
		.sType = VK_STRUCTURE_TYPE_IMAGE_CREATE_INFO,
		.imageType = VK_IMAGE_TYPE_2D,
		.format = ci->imageFormat,
		.extent = {ci->imageExtent.width, ci->imageExtent.height, 1},
		.mipLevels = 1,
		.arrayLayers = 1,
		.samples = VK_SAMPLE_COUNT_1_BIT,
		.tiling = VK_IMAGE_TILING_OPTIMAL,
		.usage = ci->imageUsage | VK_IMAGE_USAGE_TRANSFER_SRC_BIT,
		.initialLayout = VK_IMAGE_LAYOUT_UNDEFINED,
	};
	for (uint32_t i = 0; i < sc->n; i++) {
		sc->imgs[i].id = kw_create_image_msg(d, &ic);
		sc->imgs[i].format = ic.format;
		sc->imgs[i].extent = ic.extent;
		sc->imgs[i].swapchain = 1;
	}
	if (sc->external)
		sc->external = sc->ext && ext_setup(sc);
	*out = (VkSwapchainKHR)(uintptr_t)sc;
	return VK_SUCCESS;
}

static API void CALL kw_vkDestroySwapchainKHR(VkDevice dh, VkSwapchainKHR sh, const VkAllocationCallbacks *a)
{
	(void)a;
	struct kw_swapchain *sc = HANDLE(struct kw_swapchain, sh);
	if (!sc)
		return;
	struct kw_device *d = (struct kw_device *)dh;
	ext_drain(sc);
	struct jb j = {0};
	JS(&j, "{\"op\":\"destroy\",\"ids\":[");
	for (uint32_t i = 0; i < sc->n; i++)
		jb_printf(&j, i ? ",%u" : "%u", sc->imgs[i].id);
	JS(&j, "]}");
	link_send(d->link, &j, NULL, 0, 0);
	jb_free(&j);
	wl_teardown(sc);
	if (sc->xgc) {
		xcb.free_gc(sc->xconn, sc->xgc);
		xcb.flush(sc->xconn);
	}
	free(sc);
}

static API VkResult CALL kw_vkGetSwapchainImagesKHR(VkDevice d, VkSwapchainKHR sh, uint32_t *n, VkImage *out)
{
	(void)d;
	struct kw_swapchain *sc = HANDLE(struct kw_swapchain, sh);
	if (!out) {
		*n = sc->n;
		return VK_SUCCESS;
	}
	uint32_t c = *n < sc->n ? *n : sc->n;
	for (uint32_t i = 0; i < c; i++)
		out[i] = (VkImage)(uintptr_t)&sc->imgs[i];
	*n = c;
	return c < sc->n ? VK_INCOMPLETE : VK_SUCCESS;
}

static API VkResult CALL kw_vkAcquireNextImageKHR(VkDevice d, VkSwapchainKHR sh, uint64_t timeout, VkSemaphore sem, VkFence fh, uint32_t *idx)
{
	(void)d, (void)timeout, (void)sem;
	struct kw_swapchain *sc = HANDLE(struct kw_swapchain, sh);
	if (sc->dev->link->dead)
		return VK_ERROR_DEVICE_LOST;
	/* external buffers: the image is the buffer, so it is acquired again only once
	 * the compositor released it (it takes the content at commit and releases after
	 * its ACK); after 100 ms render into it anyway rather than hang (a stalled link) */
	if (sc->external && sc->ebusy[sc->next]) {
		int64_t t0 = kw_now();
		for (int t = 0; sc->ebusy[sc->next] && t < 20; t++)
			wl_pump(sc, 5);
		kw_stats.acquire_ns += kw_now() - t0;
	}
	*idx = sc->next;
	sc->next = (sc->next + 1) % sc->n;
	struct kw_fence *f = HANDLE(struct kw_fence, fh);
	if (f && !f->r)
		f->signaled = 1;
	return VK_SUCCESS;
}

/* debugging: KWVK_DUMP=FILE writes each presented frame there as a PPM */
static void dump_frame(struct kw_swapchain *sc, const char *path, const uint8_t *p, size_t len, uint32_t w, uint32_t h, uint32_t stride)
{
	char tmp[4096];
	snprintf(tmp, sizeof tmp, "%s.tmp", path);
	FILE *f = fopen(tmp, "wb"); /* renamed when complete */
	if (!f)
		return;
	int bgra = sc->format == VK_FORMAT_B8G8R8A8_UNORM || sc->format == VK_FORMAT_B8G8R8A8_SRGB;
	fprintf(f, "P6\n%u %u\n255\n", w, h);
	for (uint32_t y = 0; y < h && (size_t)(y + 1) * stride <= len; y++)
		for (uint32_t x = 0; x < w; x++) {
			const uint8_t *px = p + (size_t)y * stride + x * 4;
			uint8_t rgb[3] = {px[bgra ? 2 : 0], px[1], px[bgra ? 0 : 2]};
			fwrite(rgb, 1, 3, f);
		}
	fclose(f);
	rename(tmp, path);
}

/* wl_surface.attach, damage of the whole buffer, a frame callback where none
 * is pending, commit: after FIFO's wait for the last frame callback */
static void wl_commit(struct kw_swapchain *sc, struct wl_proxy *buffer)
{
	struct wl_proxy *s = sc->surface;
	uint32_t ver = wl.get_version(s);
	wl.marshal_flags(s, 1, NULL, ver, 0, buffer, 0, 0);
	if (ver >= 4)
		wl.marshal_flags(s, 9, NULL, ver, 0, 0, 0, (int32_t)sc->extent.width, (int32_t)sc->extent.height);
	else
		wl.marshal_flags(s, 2, NULL, ver, 0, 0, 0, (int32_t)sc->extent.width, (int32_t)sc->extent.height);
	if (!sc->frame) {
		sc->frame = wl.marshal_flags(sc->surface_wrap, 3, wl.callback_if, ver, 0, NULL);
		wl.add_listener(sc->frame, frame_listener, sc);
	}
	wl.marshal_flags(s, 6, NULL, ver, 0);
	wl.flush(sc->dpy);
}

static void wl_pace(struct kw_swapchain *sc)
{
	if (sc->mode == VK_PRESENT_MODE_FIFO_KHR)
		for (int i = 0; i < 4 && sc->frame; i++)
			wl_pump(sc, 8);
	else
		wl_pump(sc, 0);
}

/* external buffers: the host replies once the frame is queued on its device
 * (and its submits validated), then the commit names the image's wl_buffer;
 * the page's compositor takes the image's content at that commit */
static VkResult present_external(struct kw_swapchain *sc, uint32_t idx)
{
	struct kw_device *d = sc->dev;
	struct jb j = {0};
	jb_printf(&j, "{\"op\":\"present\",\"image\":%u,\"readback\":0,\"external\":1}", sc->imgs[idx].id);
	struct kw_reply *rep = link_call(d->link, &j, NULL, 0);
	jb_free(&j);
	if (kw_reply_lost(d->link, rep, "vkQueuePresentKHR")) {
		reply_free(rep);
		return VK_ERROR_DEVICE_LOST;
	}
	reply_free(rep);
	wl_pace(sc);
	sc->ebusy[idx] = 1;
	wl_commit(sc, sc->ebuf[idx]);
	return VK_SUCCESS;
}

static VkResult present_one(struct kw_swapchain *sc, uint32_t idx)
{
	struct kw_device *d = sc->dev;
	if (sc->external)
		return present_external(sc, idx);
	int wayland = sc->surf->platform == VK_ICD_WSI_PLATFORM_WAYLAND, x11 = is_x11(sc->surf);
	const char *dump = getenv("KWVK_DUMP");
	if (dump && !*dump)
		dump = NULL;
	struct jb j = {0};
	jb_printf(&j, "{\"op\":\"present\",\"image\":%u,\"readback\":%d}", sc->imgs[idx].id, wayland || x11 || dump);
	struct kw_reply *rep = link_call(d->link, &j, NULL, 0);
	jb_free(&j);
	if (kw_reply_lost(d->link, rep, "vkQueuePresentKHR")) {
		reply_free(rep);
		return VK_ERROR_DEVICE_LOST;
	}
	if (!rep->bin) {
		reply_free(rep);
		return VK_SUCCESS;
	}
	kw_stats.present_bytes += rep->binlen;
	uint32_t w = (uint32_t)js_num(js_get(rep->json, "width"), sc->extent.width);
	uint32_t h = (uint32_t)js_num(js_get(rep->json, "height"), sc->extent.height);
	uint32_t stride = (uint32_t)js_num(js_get(rep->json, "stride"), w * 4);
	if (w != sc->extent.width || h != sc->extent.height) {
		kw_log("present: host image is %ux%u, swapchain %ux%u", w, h, sc->extent.width, sc->extent.height);
		w = w < sc->extent.width ? w : sc->extent.width;
		h = h < sc->extent.height ? h : sc->extent.height;
	}
	if (dump)
		dump_frame(sc, dump, rep->bin, rep->binlen, w, h, stride);
	if (!wayland && !x11) {
		reply_free(rep);
		return VK_SUCCESS;
	}
	if (x11) {
		/* 32 bpp Z pixmap rows, in strips that fit a request */
		uint32_t maxb = xcb.max_request(sc->xconn) * 4;
		uint32_t rows = maxb > 64 + stride ? (maxb - 64) / stride : 1;
		for (uint32_t y = 0; y < h; y += rows) {
			uint32_t n = h - y < rows ? h - y : rows;
			if ((size_t)(y + n) * stride > rep->binlen)
				break;
			uint8_t *err = NULL;
			if (!sc->xchecked) { /* report the first strip's error once */
				err = xcb.request_check(sc->xconn, xcb.put_image_checked(sc->xconn, 2 /* Z pixmap */, sc->xwin, sc->xgc, (uint16_t)w,
					(uint16_t)n, 0, (int16_t)y, 0, sc->xdepth, n * stride, rep->bin + (size_t)y * stride));
				sc->xchecked = 1;
				if (err)
					kw_log("xcb_put_image: X error %u (depth %u, %ux%u)", err[1], sc->xdepth, w, n);
				free(err);
				continue;
			}
			xcb.put_image(sc->xconn, 2 /* Z pixmap */, sc->xwin, sc->xgc, (uint16_t)w, (uint16_t)n, 0, (int16_t)y, 0,
				      sc->xdepth, n * stride, rep->bin + (size_t)y * stride);
		}
		xcb.flush(sc->xconn);
		reply_free(rep);
		return VK_SUCCESS;
	}
	wl_pace(sc);
	struct shmbuf *b = wl_buffer_get(sc, sc->extent.width, sc->extent.height);
	if (b) {
		size_t dst_stride = (size_t)sc->extent.width * 4;
		for (uint32_t y = 0; y < h && (size_t)(y + 1) * stride <= rep->binlen; y++)
			memcpy((uint8_t *)b->map + y * dst_stride, rep->bin + (size_t)y * stride, (size_t)w * 4);
		b->busy = 1;
		wl_commit(sc, b->buffer);
	}
	reply_free(rep);
	return VK_SUCCESS;
}

static API VkResult CALL kw_vkQueuePresentKHR(VkQueue q, const VkPresentInfoKHR *pi)
{
	VkResult res = VK_SUCCESS;
	int64_t t0 = kw_now();
	/* after the submits held in the ICD for timeline values (they draw what
	 * this presents): wait for their release, as Mesa's queues do */
	if (kw_queue_unhold(((struct kw_queue *)q)->dev, "vkQueuePresentKHR") != VK_SUCCESS)
		return VK_ERROR_DEVICE_LOST;
	for (uint32_t i = 0; i < pi->swapchainCount; i++) {
		VkResult r = present_one(HANDLE(struct kw_swapchain, pi->pSwapchains[i]), pi->pImageIndices[i]);
		if (pi->pResults)
			pi->pResults[i] = r;
		if (r != VK_SUCCESS)
			res = r;
	}
	kw_stats.present_ns += kw_now() - t0;
	kw_stats.presents++;
	if (kw_stats_on < 0)
		kw_stats_on = getenv("KWVK_STATS") != NULL;
	if (kw_stats_on)
		kw_stats_tick();
	return res;
}


#define E(n) {#n, (PFN_vkVoidFunction)kw_##n}
static const struct {
	const char *name;
	PFN_vkVoidFunction fn;
} wsi_procs[] = {
	E(vkGetPhysicalDeviceSurfaceSupportKHR), E(vkGetPhysicalDeviceSurfaceCapabilitiesKHR),
	E(vkGetPhysicalDeviceSurfaceFormatsKHR), E(vkGetPhysicalDeviceSurfacePresentModesKHR),
	E(vkGetPhysicalDeviceSurfaceCapabilities2KHR), E(vkGetPhysicalDeviceSurfaceFormats2KHR),
	E(vkGetPhysicalDeviceWaylandPresentationSupportKHR), E(vkDestroySurfaceKHR),
	E(vkCreateWaylandSurfaceKHR), E(vkCreateHeadlessSurfaceEXT), E(vkCreateXcbSurfaceKHR), E(vkCreateXlibSurfaceKHR),
	E(vkGetPhysicalDeviceXcbPresentationSupportKHR), E(vkGetPhysicalDeviceXlibPresentationSupportKHR),
	E(vkCreateSwapchainKHR), E(vkDestroySwapchainKHR), E(vkGetSwapchainImagesKHR),
	E(vkAcquireNextImageKHR), E(vkQueuePresentKHR),
};

PFN_vkVoidFunction kw_wsi_proc(const char *name)
{
	for (size_t i = 0; i < sizeof wsi_procs / sizeof *wsi_procs; i++)
		if (!strcmp(wsi_procs[i].name, name))
			return wsi_procs[i].fn;
	return NULL;
}
