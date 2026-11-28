// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// kwvk, the guest's Vulkan ICD: shared declarations. The ICD keeps
// guest-side state (memory shadows, fences, command recording) and sends
// everything else to the page's VkRenderer as framed JSON (vk/PROTOCOL.md).
#ifndef KWVK_H
#define KWVK_H

#define VK_USE_PLATFORM_WAYLAND_KHR 1
#define VK_NO_PROTOTYPES 1
#include <vulkan/vulkan.h>
#include <vulkan/vk_icd.h>
#include <pthread.h>
#include <stddef.h>
#include <stdint.h>

#define KW_EXPORT __attribute__((visibility("default")))

/* KWVK_DEBUG=1: debugging lines on stderr */
void kw_log(const char *fmt, ...) __attribute__((format(printf, 1, 2)));
/* always on stderr, each distinct line once: errors and wrong-result warnings */
void kw_err(const char *fmt, ...) __attribute__((format(printf, 1, 2)));

/* growable byte/JSON buffer */
struct jb {
	char *p;
	size_t n, cap;
};
void jb_put(struct jb *b, const void *s, size_t n);
/* a string literal */
#define JS(b, lit) jb_put(b, lit, sizeof(lit) - 1)
void jb_printf(struct jb *b, const char *fmt, ...) __attribute__((format(printf, 2, 3)));
void jb_float(struct jb *b, double f);
/* decimal numbers without printf (hot paths: command recording) */
void jb_u64(struct jb *b, uint64_t v);
void jb_i64(struct jb *b, int64_t v);
void jb_bytes(struct jb *b, const uint8_t *p, size_t n);
/* "key":value, the key a string literal with its punctuation, e.g. JU(b, ",\"x\":", 1) */
#define JU(b, lit, v) (JS(b, lit), jb_u64(b, (uint64_t)(v)))
void jb_str(struct jb *b, const char *s);
void jb_free(struct jb *b);
void jb_reset(struct jb *b);

/* minimal JSON reading (replies only) */
const char *js_get(const char *obj, const char *key);
const char *js_skip(const char *p);
const char *js_member(const char *p, const char **k, size_t *kl, const char **v);
double js_num(const char *v, double dflt);
void js_strcpy(const char *v, char *out, size_t cap);

/* link */
struct kw_reply {
	uint32_t r;
	char *json;
	uint8_t *bin;
	size_t binlen;
	struct kw_reply *next;
};
struct kw_link {
	int fd;
	int dead; /* no more replies: every wait, submit and present returns VK_ERROR_DEVICE_LOST */
	int lost; /* the reason was printed (link_lose) */
	pthread_mutex_t send_mu;
	pthread_mutex_t mu;
	pthread_cond_t cv;
	int reading;
	uint32_t next_r;
	uint32_t next_id;
	struct kw_reply *done; /* replies not yet claimed */
};
struct kw_link *link_open(void);
void link_close(struct kw_link *l);
uint32_t link_id(struct kw_link *l);
/* send b (a JSON object); with want_reply, adds "r" and returns it */
uint32_t link_send(struct kw_link *l, struct jb *b, const void *bin, size_t binlen, int want_reply);
/* wait for the reply to r; caller frees with reply_free */
struct kw_reply *link_wait(struct kw_link *l, uint32_t r);
/* timeout_ns < 0: forever; NULL on timeout (*timed_out = 1) or a dead link */
struct kw_reply *link_wait_timeout(struct kw_link *l, uint32_t r, int64_t timeout_ns, int *timed_out);
/* has r been replied to? reads what is available without blocking */
int link_poll(struct kw_link *l, uint32_t r);
struct kw_reply *link_call(struct kw_link *l, struct jb *b, const void *bin, size_t binlen);
void reply_free(struct kw_reply *rep);
/* the device is lost (prints why once, ends every wait); call without l->mu */
void link_lose(struct kw_link *l, const char *why);
/* a reply that must not be an error: NULL (dead link) or "err" loses the device; 1 when it did */
int kw_reply_lost(struct kw_link *l, struct kw_reply *rep, const char *what);

/* objects */
struct kw_instance;
struct kw_physical_device {
	VK_LOADER_DATA loader;
	struct kw_instance *inst;
	VkPhysicalDeviceProperties props;
	VkPhysicalDeviceFeatures features;
	VkPhysicalDeviceMemoryProperties mem;
	uint32_t fmtcaps[256];
	/* texel buffer view formats: the hello's texelBuffers.formats (1 uniform,
	 * 2 storage, 4 storage atomics; vk/PROTOCOL.md, Amendments, "Texel buffers") */
	uint8_t texelcaps[256];
	uint32_t max2d;
	uint32_t timestamp_bits;
	int f16;
	uint64_t max_alloc;
	char adapter[128]; /* the WebGPU adapter, for driverInfo */
	uint64_t max_buffer; /* WebGPU's maxBufferSize */
	uint32_t ext_token; /* the hello's external.token: the host resolves external buffers (0: it does not) */
	uint32_t subgroup_size; /* the hello's subgroupSize (1 without it) */
};
struct kw_instance {
	VK_LOADER_DATA loader;
	struct kw_link *link;
	struct kw_physical_device pd;
};
struct kw_buffer;
struct kw_device {
	VK_LOADER_DATA loader;
	struct kw_physical_device *pd;
	struct kw_link *link;
	struct kw_queue *queue;
	pthread_mutex_t mu; /* buffer and memory lists */
	pthread_mutex_t rb_mu; /* one readback at a time */
	/* replies of submits whose fences were signaled at submit, oldest
	 * first (vk/PROTOCOL.md, Amendments, "Fences at submit") */
#define KW_INFLIGHT 8
	pthread_mutex_t fl_mu;
	uint32_t inflight[KW_INFLIGHT];
	int ninflight;
	int fence_sync; /* KWVK_FENCE_SYNC=1: fences signal at their submit's reply */
	struct kw_buffer *buffers;
	struct kw_memory *mems;
	/* The queue's submission order (icd.c, "Semaphores"): whether a submit
	 * is sent or held, and every send of one, under q_mu. Held submits wait
	 * in the ICD, oldest first, for timeline values nothing has signalled
	 * yet; q_cv is signalled whenever one leaves. */
	pthread_mutex_t q_mu;
	pthread_cond_t q_cv;
	struct kw_held *held, **held_tail;
	uint64_t seq; /* submits sent */
	/* timeline values signalled by sent submits that may write host-visible
	 * memory, reached at a reply (oldest first; under icd.c's sem_mu) */
	struct kw_tlpend *tl;
};
struct kw_queue {
	VK_LOADER_DATA loader;
	struct kw_device *dev;
};
struct kw_memory {
	uint32_t type;
	VkDeviceSize size;
	uint8_t *shadow, *sent;
	int mapped, touched;
	struct kw_memory *next, *prev;
};
/* byte ranges [lo, hi) of a buffer, sorted, disjoint and not adjacent; past
 * KW_MAX_RANGES the two closest are joined (what lies between is covered too) */
#define KW_MAX_RANGES 8
struct kw_ranges {
	int n;
	VkDeviceSize lo[KW_MAX_RANGES + 1], hi[KW_MAX_RANGES + 1];
};
void kw_ranges_add(struct kw_ranges *r, VkDeviceSize lo, VkDeviceSize hi);
struct kw_buffer {
	uint32_t id;
	VkDeviceSize size;
	VkBufferUsageFlags usage;
	struct kw_memory *mem;
	VkDeviceSize offset;
	struct kw_ranges dirty; /* what submitted work may have written: read back at the next wait (or map) */
	int fresh; /* bound while its memory had no last-sent copy */
	struct kw_buffer *next, *prev;
};
struct kw_image {
	uint32_t id;
	VkFormat format;
	VkExtent3D extent;
	int swapchain;
};
struct kw_obj { /* every other host object */
	uint32_t id;
};
struct kw_bview { /* a texel buffer view: its range, for the device memory tracking */
	uint32_t id; /* first, as kw_obj's */
	struct kw_buffer *buf;
	VkDeviceSize offset, range;
};
/* a descriptor set layout: its bindings sorted by number, for Vulkan's
 * consecutive binding updates and the order of dynamic offsets. Shared by
 * the sets allocated from it (a set may outlive its layout's handle). */
struct kw_dsl_binding {
	uint32_t binding, type, count;
	uint32_t dyn; /* dynamic offsets of the bindings before it (dynamic types only) */
};
struct kw_dsl {
	uint32_t id;
	int refs;
	uint32_t n;
	struct kw_dsl_binding b[];
};
struct kw_dslot {
	uint32_t binding, elem;
	struct kw_buffer *buf;
	VkDeviceSize offset, range;
	int dyn; /* index of its dynamic offset in the set, -1: not dynamic */
	int storage; /* a storage buffer or storage texel buffer (else uniform: read only) */
};
struct kw_dset {
	uint32_t id;
	struct kw_dpool *pool;
	struct kw_dsl *layout;
	struct kw_dset *next, *prev;
	struct kw_dslot *slots; /* uniform and storage buffers (texel ones too) written into this set */
	size_t nslots;
};
struct kw_dpool {
	struct kw_dset *sets;
};
struct kw_fence {
	int signaled;
	uint32_t r; /* pending submit reply */
	uint32_t polls; /* vkGetFenceStatus calls that found r pending */
	int held; /* its submit is held in the ICD (a wait before a signal): not sent yet */
	uint64_t seq; /* its submit's place in the queue (kw_device.seq) */
};
struct kw_shader {
	uint32_t id;
	int base; /* decorates BuiltIn BaseVertex, BaseInstance or DrawIndex */
	int nw; /* writable storage bindings (set << 16 | binding), -1 unknown */
	uint32_t w[];
};
struct kw_pipe {
	uint32_t id;
	int base; /* a stage reads BaseVertex, BaseInstance or DrawIndex (0 on WebGPU) */
	char *bad; /* created but cannot run on WebGPU ("unusable" reply): why */
	int nw;
	uint32_t w[];
};
#define KW_MAX_SETS 8
#define KW_MAX_DYN 32 /* dynamic offsets kept per bound set (past them: whole buffers) */
struct kw_written {
	struct kw_buffer *buf;
	struct kw_ranges r;
};
struct kw_cmdbuf {
	VK_LOADER_DATA loader;
	struct kw_device *dev;
	struct kw_cmdpool *pool;
	struct kw_cmdbuf *next, *prev;
	struct jb cmds; /* comma-separated command objects */
	struct kw_written *written; /* buffers and ranges the GPU may write */
	size_t nwritten, capwritten;
	/* buffers and ranges the GPU may read: with `written`, what vkQueueSubmit
	 * flushes of host-visible memory */
	struct kw_written *reads;
	size_t nreads, capreads;
	struct kw_pipe *pipe[2]; /* bound graphics, compute pipeline */
	struct kw_dset *sets[2][KW_MAX_SETS];
	uint32_t dyn[2][KW_MAX_SETS][KW_MAX_DYN]; /* their dynamic offsets */
	uint32_t ndyn[2][KW_MAX_SETS];
	/* recorded something the host cannot run (an unusable pipeline, a
	 * non-zero dispatch base, ...): submitting it loses the device */
	char bad[384];
};
struct kw_cmdpool {
	struct kw_cmdbuf *bufs;
};

#define HANDLE(T, h) ((T *)(uintptr_t)(h))

void kw_flush_writes(struct kw_device *d, struct kw_memory *only);
void kw_readback(struct kw_device *d, struct kw_memory *only);
uint32_t kw_create_image_msg(struct kw_device *d, const VkImageCreateInfo *ci);
/* waits until no submit is held in the ICD (a present must follow them); VK_ERROR_DEVICE_LOST after a loss */
VkResult kw_queue_unhold(struct kw_device *d, const char *call);

/* KWVK_STATS=1: where the ICD's time goes, printed every 2 s at present */
struct kw_stats {
	int64_t flush_ns, scan_bytes, write_bytes, writes;
	int64_t readback_ns, read_bytes;
	int64_t submit_ns, submit_json, submits;
	int64_t present_ns, present_bytes, presents;
	int64_t wait_ns;
	int64_t acquire_ns; /* external buffers: waiting for the compositor's release */
};
extern struct kw_stats kw_stats;
extern int kw_stats_on;
int64_t kw_now(void);
void kw_stats_tick(void);

/* WSI (wsi.c) */
PFN_vkVoidFunction kw_wsi_proc(const char *name);

#endif
