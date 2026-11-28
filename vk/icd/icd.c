// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// kwvk: the Vulkan 1.0 entry points. Instance, physical device, device,
// queue, memory, fences and command recording are guest-side; every other
// object is created on the host by a message (vk/PROTOCOL.md).
#include "kwvk.h"

#include <math.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <time.h>
#include <unistd.h>

#define API VKAPI_ATTR
#define CALL VKAPI_CALL

struct kw_stats kw_stats;
int kw_stats_on = -1;

int64_t kw_now(void)
{
	struct timespec t;
	clock_gettime(CLOCK_MONOTONIC, &t);
	return (int64_t)t.tv_sec * 1000000000 + t.tv_nsec;
}

void kw_stats_tick(void)
{
	static int64_t last;
	int64_t now = kw_now();
	if (!last)
		last = now;
	if (now - last < 2000000000)
		return;
	struct kw_stats *s = &kw_stats;
	/* per present, or per submit for compute programs (no presents) */
	double sec = (now - last) / 1e9, fr = s->presents ? (double)s->presents : s->submits ? (double)s->submits : 1;
	fprintf(stderr,
		"kwvk stats: %.0f presents/s, %.0f submits/s; per %s: flush %.2f ms (scanned %.0f KiB, wrote %.0f KiB in %.1f writes), "
		"submit %.2f ms (%.1f, %.0f KiB JSON), fence waits %.2f ms, readback %.2f ms (%.0f KiB), present %.2f ms (%.0f KiB), acquire %.2f ms\n",
		s->presents / sec, s->submits / sec, s->presents ? "frame" : "submit", s->flush_ns / fr / 1e6, s->scan_bytes / fr / 1024, s->write_bytes / fr / 1024, s->writes / fr,
		s->submit_ns / fr / 1e6, s->submits / fr, s->submit_json / fr / 1024, s->wait_ns / fr / 1e6, s->readback_ns / fr / 1e6,
		s->read_bytes / fr / 1024, s->present_ns / fr / 1e6, s->present_bytes / fr / 1024, s->acquire_ns / fr / 1e6);
	memset(s, 0, sizeof *s);
	last = now;
}

static uint64_t round4(uint64_t v) { return (v + 3) & ~3ull; }

/* ---- JSON helpers for Vulkan structs ---- */

static void j_size(struct jb *b, VkDeviceSize v)
{
	if (v == VK_WHOLE_SIZE)
		JS(b, "-1");
	else
		jb_printf(b, "%llu", (unsigned long long)v);
}
static void j_layers(struct jb *b, const VkImageSubresourceLayers *s)
{
	jb_printf(b, "{\"aspectMask\":%u,\"mipLevel\":%u,\"baseArrayLayer\":%u,\"layerCount\":%u}",
		  s->aspectMask, s->mipLevel, s->baseArrayLayer, s->layerCount);
}
static void j_range(struct jb *b, const VkImageSubresourceRange *s)
{
	jb_printf(b, "{\"aspectMask\":%u,\"baseMipLevel\":%u,\"levelCount\":%u,\"baseArrayLayer\":%u,\"layerCount\":%u}",
		  s->aspectMask, s->baseMipLevel, s->levelCount, s->baseArrayLayer, s->layerCount);
}
static void j_off3(struct jb *b, VkOffset3D o) { jb_printf(b, "{\"x\":%d,\"y\":%d,\"z\":%d}", o.x, o.y, o.z); }
static void j_ext3(struct jb *b, VkExtent3D e) { jb_printf(b, "{\"width\":%u,\"height\":%u,\"depth\":%u}", e.width, e.height, e.depth); }
static void j_rect(struct jb *b, VkRect2D r)
{
	jb_printf(b, "{\"offset\":{\"x\":%d,\"y\":%d},\"extent\":{\"width\":%u,\"height\":%u}}",
		  r.offset.x, r.offset.y, r.extent.width, r.extent.height);
}
static void j_floats(struct jb *b, const float *f, int n)
{
	JS(b, "[");
	for (int i = 0; i < n; i++) {
		if (i)
			JS(b, ",");
		jb_float(b, f[i]);
	}
	JS(b, "]");
}
static void j_ccolor(struct jb *b, const VkClearColorValue *c)
{
	JS(b, "{\"float32\":");
	j_floats(b, c->float32, 4);
	jb_printf(b, ",\"int32\":[%d,%d,%d,%d],\"uint32\":[%u,%u,%u,%u]}", c->int32[0], c->int32[1],
		  c->int32[2], c->int32[3], c->uint32[0], c->uint32[1], c->uint32[2], c->uint32[3]);
}
static void j_cds(struct jb *b, const VkClearDepthStencilValue *d)
{
	JS(b, "{\"depth\":");
	jb_float(b, d->depth);
	jb_printf(b, ",\"stencil\":%u}", d->stencil);
}
static void j_cvalue(struct jb *b, const VkClearValue *v)
{
	JS(b, "{\"color\":");
	j_ccolor(b, &v->color);
	JS(b, ",\"depthStencil\":");
	j_cds(b, &v->depthStencil);
	JS(b, "}");
}
static void j_bytes(struct jb *b, const void *p, size_t n) { jb_bytes(b, p, n); }
static void j_u32s(struct jb *b, const uint32_t *v, uint32_t n)
{
	JS(b, "[");
	for (uint32_t i = 0; i < n; i++) {
		if (i)
			JS(b, ",");
		jb_u64(b, v ? v[i] : 0);
	}
	JS(b, "]");
}

static uint32_t oid(uint64_t h) { return h ? HANDLE(struct kw_obj, h)->id : 0; }

static void send_msg(struct kw_device *d, struct jb *b, const void *bin, size_t n)
{
	link_send(d->link, b, bin, n, 0);
	jb_free(b);
}

static void destroy_ids(struct kw_link *l, uint32_t *ids, size_t n)
{
	if (!n)
		return;
	struct jb b = {0};
	JS(&b, "{\"op\":\"destroy\",\"ids\":");
	j_u32s(&b, ids, (uint32_t)n);
	JS(&b, "}");
	link_send(l, &b, NULL, 0, 0);
	jb_free(&b);
}
static void destroy_id(struct kw_device *d, uint32_t id)
{
	if (id)
		destroy_ids(d->link, &id, 1);
}

/* ---- instance and physical device ---- */

static const VkExtensionProperties inst_exts[] = {
	{VK_KHR_SURFACE_EXTENSION_NAME, 25},
	{VK_KHR_WAYLAND_SURFACE_EXTENSION_NAME, 6},
	{VK_EXT_HEADLESS_SURFACE_EXTENSION_NAME, 1},
	{VK_KHR_GET_PHYSICAL_DEVICE_PROPERTIES_2_EXTENSION_NAME, 2},
	{VK_KHR_GET_SURFACE_CAPABILITIES_2_EXTENSION_NAME, 1},
	{VK_EXT_SWAPCHAIN_COLOR_SPACE_EXTENSION_NAME, 5},
	{VK_KHR_DEVICE_GROUP_CREATION_EXTENSION_NAME, 1},
	{VK_KHR_EXTERNAL_MEMORY_CAPABILITIES_EXTENSION_NAME, 1},
	{VK_KHR_EXTERNAL_SEMAPHORE_CAPABILITIES_EXTENSION_NAME, 1},
	{VK_KHR_EXTERNAL_FENCE_CAPABILITIES_EXTENSION_NAME, 1},
	{"VK_KHR_xcb_surface", 6},
	{"VK_KHR_xlib_surface", 6},
};
static const VkExtensionProperties dev_exts[] = {
	{VK_KHR_SWAPCHAIN_EXTENSION_NAME, 70},
	{VK_KHR_MAINTENANCE_1_EXTENSION_NAME, 2},
	{VK_KHR_MAINTENANCE_2_EXTENSION_NAME, 1},
	{VK_KHR_MAINTENANCE_3_EXTENSION_NAME, 1},
	{VK_KHR_GET_MEMORY_REQUIREMENTS_2_EXTENSION_NAME, 1},
	{VK_KHR_BIND_MEMORY_2_EXTENSION_NAME, 1},
	{VK_KHR_DEDICATED_ALLOCATION_EXTENSION_NAME, 3},
	{VK_KHR_DRIVER_PROPERTIES_EXTENSION_NAME, 1},
	{VK_KHR_DESCRIPTOR_UPDATE_TEMPLATE_EXTENSION_NAME, 1},
	{VK_KHR_CREATE_RENDERPASS_2_EXTENSION_NAME, 1},
	{VK_KHR_DEPTH_STENCIL_RESOLVE_EXTENSION_NAME, 1},
	{VK_KHR_DYNAMIC_RENDERING_EXTENSION_NAME, 1},
	{VK_EXT_EXTENDED_DYNAMIC_STATE_EXTENSION_NAME, 1},
	{VK_KHR_STORAGE_BUFFER_STORAGE_CLASS_EXTENSION_NAME, 1},
	{VK_KHR_SHADER_DRAW_PARAMETERS_EXTENSION_NAME, 1},
	{VK_KHR_TIMELINE_SEMAPHORE_EXTENSION_NAME, 2},
	{VK_KHR_IMAGELESS_FRAMEBUFFER_EXTENSION_NAME, 1},
	{VK_KHR_SEPARATE_DEPTH_STENCIL_LAYOUTS_EXTENSION_NAME, 1},
	{VK_KHR_SHADER_SUBGROUP_EXTENDED_TYPES_EXTENSION_NAME, 1},
	/* view formats: the host gives every single-sampled image, swapchain
	 * images included, its own format and its sRGB twin (others are made
	 * in the image's format, logged) */
	{VK_KHR_IMAGE_FORMAT_LIST_EXTENSION_NAME, 1},
	{VK_KHR_SWAPCHAIN_MUTABLE_FORMAT_EXTENSION_NAME, 1},
};

static VkResult fill_props(const VkExtensionProperties *src, uint32_t n, uint32_t *count, VkExtensionProperties *out)
{
	if (!out) {
		*count = n;
		return VK_SUCCESS;
	}
	uint32_t c = *count < n ? *count : n;
	memcpy(out, src, c * sizeof *out);
	*count = c;
	return c < n ? VK_INCOMPLETE : VK_SUCCESS;
}

static API VkResult CALL kw_vkEnumerateInstanceExtensionProperties(const char *layer, uint32_t *count, VkExtensionProperties *out)
{
	if (layer)
		return VK_ERROR_LAYER_NOT_PRESENT;
	return fill_props(inst_exts, sizeof inst_exts / sizeof *inst_exts, count, out);
}

#define PD(h) ((struct kw_physical_device *)(h))
static API VkResult CALL kw_vkEnumerateDeviceExtensionProperties(VkPhysicalDevice pd, const char *layer, uint32_t *count, VkExtensionProperties *out)
{
	if (layer)
		return VK_ERROR_LAYER_NOT_PRESENT;
	enum { N = sizeof dev_exts / sizeof *dev_exts };
	VkExtensionProperties all[N + 4];
	uint32_t n = N;
	memcpy(all, dev_exts, sizeof dev_exts);
	all[n++] = (VkExtensionProperties){VK_EXT_HOST_QUERY_RESET_EXTENSION_NAME, 1};
	if (PD(pd)->f16)
		all[n++] = (VkExtensionProperties){VK_KHR_SHADER_FLOAT16_INT8_EXTENSION_NAME, 1};
	all[n++] = (VkExtensionProperties){VK_KHR_16BIT_STORAGE_EXTENSION_NAME, 1};
	all[n++] = (VkExtensionProperties){VK_KHR_8BIT_STORAGE_EXTENSION_NAME, 1};
	return fill_props(all, n, count, out);
}

static API VkResult CALL kw_vkEnumerateDeviceLayerProperties(VkPhysicalDevice pd, uint32_t *count, VkLayerProperties *out)
{
	(void)pd;
	(void)out;
	*count = 0;
	return VK_SUCCESS;
}

/* The host's maxBindGroups: push constants take the group after a layout's
 * sets (vk/PROTOCOL.md). */
static uint32_t kw_bind_groups = 4;

static uint32_t lim(const char *limits, const char *name, uint32_t dflt)
{
	double v = js_num(js_get(limits, name), -1);
	if (v < 0)
		return dflt;
	return v > 4294967295.0 ? 4294967295u : (uint32_t)v;
}

/*
 * KWVK_SUBGROUP_SIZE=N (a power of two up to 128) asks the host for N as the
 * subgroup size (default: the host's, 32). Apps size workgroups by it
 * (llama.cpp's mat-vec shaders run one invocation per workgroup at 1); the
 * host lowers the subgroup builtins to arithmetic for it, and no subgroup
 * operation is offered (supportedStages 0). 0: unset or invalid.
 */
static uint32_t kw_subgroup_request(void)
{
	const char *e = getenv("KWVK_SUBGROUP_SIZE");
	long n = e && *e ? strtol(e, NULL, 10) : 0;
	return n >= 1 && n <= 128 && !(n & (n - 1)) ? (uint32_t)n : 0;
}

/* wgpu: the app's engine is wgpu-hal (VkApplicationInfo's pEngineName) */
static void pd_init(struct kw_physical_device *pd, struct kw_reply *rep, int wgpu)
{
	const char *L = js_get(rep->json, "limits");
	VkPhysicalDeviceProperties *p = &pd->props;
	VkPhysicalDeviceLimits *l = &p->limits;
	char desc[128] = "", dev[128] = "";
	const char *ad = js_get(rep->json, "adapter");
	js_strcpy(js_get(ad, "description"), desc, sizeof desc);
	js_strcpy(js_get(ad, "device"), dev, sizeof dev);
	p->apiVersion = VK_MAKE_VERSION(1, 2, 314);
	p->driverVersion = VK_MAKE_VERSION(0, 1, 0);
	p->vendorID = 0x10005;
	p->deviceID = 0x6b77;
	p->deviceType = VK_PHYSICAL_DEVICE_TYPE_INTEGRATED_GPU;
	/* The device name has the adapter, with the words programs read meaning
	 * into spelled apart ("a.p.p.l.e m.e.t.a.l-3"): Ollama takes a device
	 * whose name has "apple" or "metal" for a Metal one, "hip" for ROCm,
	 * "cuda" for CUDA, and then does not use it. driverInfo has it as it
	 * is. KWVK_DEVICE_NAME sets another name. */
	{
		static const char *const words[] = {"apple", "metal", "cuda", "rocm", "hip"};
		const char *src = *desc ? desc : dev;
		char safe[200];
		size_t o = 0;
		while (*src && o + 12 < sizeof safe) {
			size_t w = 0;
			for (size_t k = 0; k < sizeof words / sizeof *words; k++)
				if (strncasecmp(src, words[k], strlen(words[k])) == 0)
					w = strlen(words[k]);
			if (!w) {
				safe[o++] = *src++;
				continue;
			}
			for (size_t k = 0; k < w; k++) {
				if (k)
					safe[o++] = '.';
				safe[o++] = *src++;
			}
		}
		safe[o] = 0;
		snprintf(p->deviceName, sizeof p->deviceName, "kwvk (WebGPU%s%s)", *safe ? ": " : "", safe);
	}
	snprintf(pd->adapter, sizeof pd->adapter, "%s", *desc ? desc : dev);
	const char *dn = getenv("KWVK_DEVICE_NAME");
	if (dn && *dn)
		snprintf(p->deviceName, sizeof p->deviceName, "%s", dn);
	memcpy(p->pipelineCacheUUID, "kwvk-webgpu-0001", 16);

	/* The subgroup size: what the host translates the subgroup builtins for
	 * (vk/PROTOCOL.md, Amendments, "Subgroup size"); an older host says
	 * nothing and gets 1, as before (KWVK_SUBGROUP_SIZE then has no effect). */
	{
		double sg = js_num(js_get(rep->json, "subgroupSize"), 1);
		uint32_t n = sg >= 1 && sg <= 128 ? (uint32_t)sg : 1;
		pd->subgroup_size = n & (n - 1) ? 1 : n;
		uint32_t want = kw_subgroup_request();
		if (want && want != pd->subgroup_size)
			kw_err("KWVK_SUBGROUP_SIZE=%u: the host did not take it (an older host); the subgroup size reported is %u", want, pd->subgroup_size);
	}
	/* the host turns swapchain images into a page compositor's pictures (wsi.c, external buffers) */
	pd->ext_token = (uint32_t)js_num(js_get(js_get(rep->json, "external"), "token"), 0);
	uint32_t t2 = lim(L, "maxTextureDimension2D", 8192);
	pd->max2d = t2;
	l->maxImageDimension1D = lim(L, "maxTextureDimension1D", 8192);
	l->maxImageDimension2D = t2;
	l->maxImageDimension3D = lim(L, "maxTextureDimension3D", 2048);
	l->maxImageDimensionCube = t2;
	l->maxImageArrayLayers = lim(L, "maxTextureArrayLayers", 256);
	/* texel buffers: the host's formats and limit; a view's offset is a
	 * multiple of 16 (the host binds from the storage alignment below it
	 * and tells the shader the rest); none from an older host */
	{
		const char *tb = js_get(rep->json, "texelBuffers");
		double me = js_num(js_get(tb, "maxElements"), 0);
		l->maxTexelBufferElements = tb && me >= 65536 ? (me > 4294967295.0 ? 0xffffffffu : (uint32_t)me) : 65536;
		const char *tf = js_get(tb, "formats"), *tk, *tv, *tq = tf;
		size_t tkl;
		while (tq && (tq = js_member(tq, &tk, &tkl, &tv))) {
			long n = strtol(tk, NULL, 10);
			if (n > 0 && n < 256)
				pd->texelcaps[n] = (uint8_t)js_num(tv, 0);
		}
		l->minTexelBufferOffsetAlignment = tb ? 16 : 256;
	}
	l->maxUniformBufferRange = lim(L, "maxUniformBufferBindingSize", 65536);
	l->maxStorageBufferRange = lim(L, "maxStorageBufferBindingSize", 134217728);
	l->maxPushConstantsSize = 128;
	l->maxMemoryAllocationCount = 65536;
	l->maxSamplerAllocationCount = 4000;
	l->bufferImageGranularity = 1;
	/* Every bind group is a set; a layout that also has push constants gets
	 * one less (vkCreatePipelineLayout). */
	l->maxBoundDescriptorSets = kw_bind_groups = lim(L, "maxBindGroups", 4);
	l->maxPerStageDescriptorSamplers = lim(L, "maxSamplersPerShaderStage", 16);
	l->maxPerStageDescriptorUniformBuffers = lim(L, "maxUniformBuffersPerShaderStage", 12);
	l->maxPerStageDescriptorStorageBuffers = lim(L, "maxStorageBuffersPerShaderStage", 8);
	l->maxPerStageDescriptorSampledImages = lim(L, "maxSampledTexturesPerShaderStage", 16);
	l->maxPerStageDescriptorStorageImages = lim(L, "maxStorageTexturesPerShaderStage", 4);
	l->maxPerStageDescriptorInputAttachments = 4;
	l->maxPerStageResources = 128;
	l->maxDescriptorSetSamplers = l->maxPerStageDescriptorSamplers * 3;
	l->maxDescriptorSetUniformBuffers = l->maxPerStageDescriptorUniformBuffers * 3;
	l->maxDescriptorSetUniformBuffersDynamic = lim(L, "maxDynamicUniformBuffersPerPipelineLayout", 8);
	l->maxDescriptorSetStorageBuffers = l->maxPerStageDescriptorStorageBuffers * 3;
	l->maxDescriptorSetStorageBuffersDynamic = lim(L, "maxDynamicStorageBuffersPerPipelineLayout", 4);
	l->maxDescriptorSetSampledImages = l->maxPerStageDescriptorSampledImages * 3;
	l->maxDescriptorSetStorageImages = l->maxPerStageDescriptorStorageImages * 3;
	l->maxDescriptorSetInputAttachments = 4;
	l->maxVertexInputAttributes = lim(L, "maxVertexAttributes", 16);
	l->maxVertexInputBindings = lim(L, "maxVertexBuffers", 8);
	l->maxVertexInputAttributeOffset = 2047;
	l->maxVertexInputBindingStride = lim(L, "maxVertexBufferArrayStride", 2048);
	/* WebGPU's maxInterStageShaderVariables locations. wgpu derives its own
	 * limit as these components / 4 - 1 ("-1 for position", wgpu-hal's
	 * vulkan/adapter.rs) and asks for WebGPU's default 16, so wgpu-hal gets
	 * one location more, which it never uses; any other app gets exactly
	 * what WebGPU takes */
	uint32_t inter = lim(L, "maxInterStageShaderVariables", 16);
	l->maxVertexOutputComponents = (inter + (wgpu ? 1 : 0)) * 4;
	l->maxFragmentInputComponents = l->maxVertexOutputComponents;
	l->maxFragmentOutputAttachments = lim(L, "maxColorAttachments", 8);
	l->maxFragmentDualSrcAttachments = 0;
	/* The sum, so nothing derived from it is cut: wgpu fits storage buffers,
	 * storage images and color attachments under this value together. */
	l->maxFragmentCombinedOutputResources = l->maxFragmentOutputAttachments +
		l->maxPerStageDescriptorStorageBuffers + l->maxPerStageDescriptorStorageImages;
	l->maxComputeSharedMemorySize = lim(L, "maxComputeWorkgroupStorageSize", 16384);
	uint32_t wg = lim(L, "maxComputeWorkgroupsPerDimension", 65535);
	l->maxComputeWorkGroupCount[0] = l->maxComputeWorkGroupCount[1] = l->maxComputeWorkGroupCount[2] = wg;
	l->maxComputeWorkGroupInvocations = lim(L, "maxComputeInvocationsPerWorkgroup", 256);
	l->maxComputeWorkGroupSize[0] = lim(L, "maxComputeWorkgroupSizeX", 256);
	l->maxComputeWorkGroupSize[1] = lim(L, "maxComputeWorkgroupSizeY", 256);
	l->maxComputeWorkGroupSize[2] = lim(L, "maxComputeWorkgroupSizeZ", 64);
	l->subPixelPrecisionBits = 4;
	l->subTexelPrecisionBits = 4;
	l->mipmapPrecisionBits = 4;
	l->maxDrawIndexedIndexValue = 0xffffffffu;
	/* multiDrawIndirect: the host draws an indirect call's drawCount records
	 * one by one (js/core/vk-exec.ts), so any count works; 2^16 - 1 is the
	 * least the spec allows with the feature */
	l->maxDrawIndirectCount = 65535;
	l->maxSamplerLodBias = 0;
	l->maxSamplerAnisotropy = 16;
	l->maxViewports = 1;
	l->maxViewportDimensions[0] = l->maxViewportDimensions[1] = t2;
	l->viewportBoundsRange[0] = -2.0f * t2;
	l->viewportBoundsRange[1] = 2.0f * t2 - 1;
	l->minMemoryMapAlignment = 64;
	l->minUniformBufferOffsetAlignment = lim(L, "minUniformBufferOffsetAlignment", 256);
	l->minStorageBufferOffsetAlignment = lim(L, "minStorageBufferOffsetAlignment", 256);
	l->minTexelOffset = -8;
	l->maxTexelOffset = 7;
	l->minTexelGatherOffset = -8;
	l->maxTexelGatherOffset = 7;
	l->minInterpolationOffset = -0.5f;
	l->maxInterpolationOffset = 0.4375f;
	l->subPixelInterpolationOffsetBits = 4;
	l->maxFramebufferWidth = t2;
	l->maxFramebufferHeight = t2;
	l->maxFramebufferLayers = 1;
	VkSampleCountFlags sc = VK_SAMPLE_COUNT_1_BIT | VK_SAMPLE_COUNT_4_BIT;
	l->framebufferColorSampleCounts = sc;
	l->framebufferDepthSampleCounts = sc;
	l->framebufferStencilSampleCounts = sc;
	l->framebufferNoAttachmentsSampleCounts = sc;
	l->maxColorAttachments = lim(L, "maxColorAttachments", 8);
	l->sampledImageColorSampleCounts = sc;
	l->sampledImageIntegerSampleCounts = VK_SAMPLE_COUNT_1_BIT;
	l->sampledImageDepthSampleCounts = sc;
	l->sampledImageStencilSampleCounts = VK_SAMPLE_COUNT_1_BIT;
	l->storageImageSampleCounts = VK_SAMPLE_COUNT_1_BIT;
	l->maxSampleMaskWords = 1;
	l->timestampComputeAndGraphics = VK_FALSE; /* set below with timestamp-query */
	l->timestampPeriod = 1;
	l->discreteQueuePriorities = 2;
	l->pointSizeRange[0] = l->pointSizeRange[1] = 1;
	l->lineWidthRange[0] = l->lineWidthRange[1] = 1;
	l->strictLines = VK_FALSE;
	l->standardSampleLocations = VK_TRUE;
	l->optimalBufferCopyOffsetAlignment = 256;
	l->optimalBufferCopyRowPitchAlignment = 256;
	l->nonCoherentAtomSize = 4;

	const char *F = js_get(rep->json, "features");
	const char *Fe = F ? js_skip(F) : NULL;
#define HAS(name) (F && memmem(F, Fe - F, "\"" name "\"", strlen(name) + 2) != NULL)
	VkPhysicalDeviceFeatures *f = &pd->features;
	f->fullDrawIndexUint32 = 1;
	f->imageCubeArray = 1;
	f->independentBlend = 1;
	f->sampleRateShading = 1;
	f->depthClamp = HAS("depth-clip-control");
	f->depthBiasClamp = 1;
	f->samplerAnisotropy = 1;
	f->textureCompressionBC = HAS("texture-compression-bc");
	f->textureCompressionETC2 = HAS("texture-compression-etc2");
	f->textureCompressionASTC_LDR = HAS("texture-compression-astc");
	f->fragmentStoresAndAtomics = 1;
	f->shaderClipDistance = HAS("clip-distances");
	f->dualSrcBlend = HAS("dual-source-blending");
	f->drawIndirectFirstInstance = HAS("indirect-first-instance");
	f->multiDrawIndirect = 1; /* GZDoom's ZVulkan takes no device without it */
	f->occlusionQueryPrecise = 0;
	pd->f16 = HAS("shader-f16");
	if (HAS("timestamp-query")) {
		l->timestampComputeAndGraphics = VK_TRUE;
		pd->timestamp_bits = 64;
	}
	/* the translator flattens constant-size descriptor arrays, dynamic
	 * indices included (vk/PROTOCOL.md) */
	f->shaderSampledImageArrayDynamicIndexing = 1;
	f->shaderUniformBufferArrayDynamicIndexing = 1;
	f->shaderStorageBufferArrayDynamicIndexing = 1;
#undef HAS
	if (f->dualSrcBlend)
		l->maxFragmentDualSrcAttachments = 1;
	if (f->shaderClipDistance)
		l->maxClipDistances = l->maxCombinedClipAndCullDistances = 8;

	const char *fm = js_get(rep->json, "formats"), *k, *v, *q = fm;
	size_t kl;
	while (q && (q = js_member(q, &k, &kl, &v))) {
		long n = strtol(k, NULL, 10);
		if (n > 0 && n < 256)
			pd->fmtcaps[n] = (uint32_t)js_num(v, 0);
	}

	VkPhysicalDeviceMemoryProperties *m = &pd->mem;
	/* Two heaps. Device-only memory (type 0) lives on the page's GPU and
	 * has no copy in the guest: WebGPU tells no memory size, so its heap is
	 * 4 GiB, or KWVK_HEAP_MB (apps such as ggml and Ollama decide by it how
	 * much of a model goes on the GPU; an allocation the GPU cannot hold
	 * fails there). Host-visible memory (type 1) is a malloc'd shadow: the
	 * guest's RAM bounds it. */
	m->memoryHeapCount = 2;
	uint64_t ram = (uint64_t)sysconf(_SC_PHYS_PAGES) * (uint64_t)sysconf(_SC_PAGESIZE);
	const char *hm = getenv("KWVK_HEAP_MB");
	uint64_t devheap = hm && atoll(hm) >= 64 ? (uint64_t)atoll(hm) << 20 : 4ull << 30;
	m->memoryHeaps[0].size = devheap;
	m->memoryHeaps[1].size = ram >= (64ull << 20) ? ram / 2 : (1ull << 30);
	m->memoryHeaps[1].flags = 0;
	/* maxMemoryAllocationSize is what one buffer can be and one storage
	 * binding can show: WebGPU's maxBufferSize and
	 * maxStorageBufferBindingSize (apps such as ggml size their buffers by
	 * it and bind them whole) */
	double mb = js_num(js_get(L, "maxBufferSize"), 268435456);
	pd->max_buffer = mb >= 1.8e19 ? UINT64_MAX : (uint64_t)mb;
	double sb = js_num(js_get(L, "maxStorageBufferBindingSize"), 134217728);
	pd->max_alloc = sb >= 1.8e19 ? UINT64_MAX : (uint64_t)sb & ~3ull;
	if (pd->max_alloc > pd->max_buffer)
		pd->max_alloc = pd->max_buffer;
	m->memoryHeaps[0].flags = VK_MEMORY_HEAP_DEVICE_LOCAL_BIT;
	/* No DEVICE_LOCAL | HOST_VISIBLE type: GPU-written memory the app keeps
	 * mapped is read back at every wait, so apps that prefer it on an
	 * integrated GPU (ggml puts every device buffer there, SDL3's GPU API
	 * its uniform buffers) are steered to device-only memory or the plain
	 * host-visible type (vk/PROTOCOL.md, Amendments). */
	m->memoryTypeCount = 2;
	m->memoryTypes[0].propertyFlags = VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT;
	m->memoryTypes[0].heapIndex = 0;
	/* the shadow is the guest's own RAM, so the CPU's reads of it are cached
	 * (DDNet asks for HOST_VISIBLE | HOST_CACHED for every buffer it maps) */
	m->memoryTypes[1].propertyFlags =
		VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT | VK_MEMORY_PROPERTY_HOST_COHERENT_BIT | VK_MEMORY_PROPERTY_HOST_CACHED_BIT;
	m->memoryTypes[1].heapIndex = 1;
}

static API VkResult CALL kw_vkCreateInstance(const VkInstanceCreateInfo *ci, const VkAllocationCallbacks *a, VkInstance *out)
{
	(void)a;
	struct kw_link *l = link_open();
	if (!l)
		return VK_ERROR_INCOMPATIBLE_DRIVER;
	struct jb b = {0};
	/* the subgroup size to report: KWVK_SUBGROUP_SIZE, else 0 (the host's
	 * choice); the reply says what the host translates for (pd_init) */
	jb_printf(&b, "{\"op\":\"hello\",\"version\":1,\"subgroupSize\":%u", kw_subgroup_request());
	/* the engine's name: a hint for which way the app's viewports point,
	 * so pipelines are made for that first (vk/PROTOCOL.md, Amendments,
	 * "Y flip hint") */
	const VkApplicationInfo *ai = ci ? ci->pApplicationInfo : NULL;
	if (ai && ai->pEngineName) {
		jb_printf(&b, ",\"engineName\":");
		jb_str(&b, ai->pEngineName);
	}
	jb_printf(&b, "}");
	struct kw_reply *rep = link_call(l, &b, NULL, 0);
	jb_free(&b);
	if (!rep || js_get(rep->json, "err")) {
		reply_free(rep);
		link_close(l);
		return VK_ERROR_INCOMPATIBLE_DRIVER;
	}
	struct kw_instance *inst = calloc(1, sizeof *inst);
	set_loader_magic_value(inst);
	set_loader_magic_value(&inst->pd);
	inst->link = l;
	inst->pd.inst = inst;
	pd_init(&inst->pd, rep, ai && ai->pEngineName && !strcmp(ai->pEngineName, "wgpu-hal"));
	reply_free(rep);
	*out = (VkInstance)inst;
	return VK_SUCCESS;
}

static API void CALL kw_vkDestroyInstance(VkInstance i, const VkAllocationCallbacks *a)
{
	(void)a;
	struct kw_instance *inst = (struct kw_instance *)i;
	if (!inst)
		return;
	link_close(inst->link);
	free(inst);
}

static API VkResult CALL kw_vkEnumeratePhysicalDevices(VkInstance i, uint32_t *count, VkPhysicalDevice *out)
{
	struct kw_instance *inst = (struct kw_instance *)i;
	if (!out) {
		*count = 1;
		return VK_SUCCESS;
	}
	if (*count < 1)
		return VK_INCOMPLETE;
	*count = 1;
	out[0] = (VkPhysicalDevice)&inst->pd;
	return VK_SUCCESS;
}


static API void CALL kw_vkGetPhysicalDeviceProperties(VkPhysicalDevice pd, VkPhysicalDeviceProperties *p) { *p = PD(pd)->props; }
static API void CALL kw_vkGetPhysicalDeviceFeatures(VkPhysicalDevice pd, VkPhysicalDeviceFeatures *f) { *f = PD(pd)->features; }
static API void CALL kw_vkGetPhysicalDeviceMemoryProperties(VkPhysicalDevice pd, VkPhysicalDeviceMemoryProperties *m) { *m = PD(pd)->mem; }

static API void CALL kw_vkGetPhysicalDeviceQueueFamilyProperties(VkPhysicalDevice pd, uint32_t *count, VkQueueFamilyProperties *out)
{
	(void)pd;
	if (!out) {
		*count = 1;
		return;
	}
	if (*count < 1)
		return;
	*count = 1;
	memset(out, 0, sizeof *out);
	out->queueFlags = VK_QUEUE_GRAPHICS_BIT | VK_QUEUE_COMPUTE_BIT | VK_QUEUE_TRANSFER_BIT;
	out->queueCount = 1;
	out->timestampValidBits = PD(pd)->timestamp_bits;
	out->minImageTransferGranularity = (VkExtent3D){1, 1, 1};
}

static VkFormatFeatureFlags fmt_features(uint32_t c)
{
	VkFormatFeatureFlags f = 0;
	if (c & 1)
		f |= VK_FORMAT_FEATURE_SAMPLED_IMAGE_BIT | VK_FORMAT_FEATURE_BLIT_SRC_BIT;
	if (c & 2)
		f |= VK_FORMAT_FEATURE_SAMPLED_IMAGE_FILTER_LINEAR_BIT;
	if (c & 4)
		f |= VK_FORMAT_FEATURE_COLOR_ATTACHMENT_BIT | VK_FORMAT_FEATURE_BLIT_DST_BIT;
	if (c & 8)
		f |= VK_FORMAT_FEATURE_COLOR_ATTACHMENT_BLEND_BIT;
	if (c & 16)
		f |= VK_FORMAT_FEATURE_DEPTH_STENCIL_ATTACHMENT_BIT;
	if (c & 32)
		f |= VK_FORMAT_FEATURE_STORAGE_IMAGE_BIT;
	if (c & ~64u)
		f |= VK_FORMAT_FEATURE_TRANSFER_SRC_BIT | VK_FORMAT_FEATURE_TRANSFER_DST_BIT;
	return f;
}

static API void CALL kw_vkGetPhysicalDeviceFormatProperties(VkPhysicalDevice pd, VkFormat fmt, VkFormatProperties *out)
{
	uint32_t c = (fmt > 0 && fmt < 256) ? PD(pd)->fmtcaps[fmt] : 0;
	memset(out, 0, sizeof *out);
	out->optimalTilingFeatures = fmt_features(c);
	if (c & 64)
		out->bufferFeatures = VK_FORMAT_FEATURE_VERTEX_BUFFER_BIT;
	uint8_t t = (fmt > 0 && fmt < 256) ? PD(pd)->texelcaps[fmt] : 0;
	if (t & 1)
		out->bufferFeatures |= VK_FORMAT_FEATURE_UNIFORM_TEXEL_BUFFER_BIT;
	if (t & 2)
		out->bufferFeatures |= VK_FORMAT_FEATURE_STORAGE_TEXEL_BUFFER_BIT;
	if (t & 4)
		out->bufferFeatures |= VK_FORMAT_FEATURE_STORAGE_TEXEL_BUFFER_ATOMIC_BIT;
}

static API VkResult CALL kw_vkGetPhysicalDeviceImageFormatProperties(VkPhysicalDevice pdh, VkFormat fmt, VkImageType type,
	VkImageTiling tiling, VkImageUsageFlags usage, VkImageCreateFlags flags, VkImageFormatProperties *out)
{
	struct kw_physical_device *pd = PD(pdh);
	uint32_t c = (fmt > 0 && fmt < 256) ? pd->fmtcaps[fmt] : 0;
	memset(out, 0, sizeof *out);
	(void)flags;
	if (tiling != VK_IMAGE_TILING_OPTIMAL || !(c & ~64u))
		return VK_ERROR_FORMAT_NOT_SUPPORTED;
	if (((usage & VK_IMAGE_USAGE_SAMPLED_BIT) && !(c & 1)) ||
	    ((usage & VK_IMAGE_USAGE_COLOR_ATTACHMENT_BIT) && !(c & 4)) ||
	    ((usage & VK_IMAGE_USAGE_DEPTH_STENCIL_ATTACHMENT_BIT) && !(c & 16)) ||
	    ((usage & VK_IMAGE_USAGE_STORAGE_BIT) && !(c & 32)) ||
	    ((usage & VK_IMAGE_USAGE_INPUT_ATTACHMENT_BIT) && !(c & 1)))
		return VK_ERROR_FORMAT_NOT_SUPPORTED;
	const VkPhysicalDeviceLimits *l = &pd->props.limits;
	uint32_t dim = type == VK_IMAGE_TYPE_1D ? l->maxImageDimension1D : type == VK_IMAGE_TYPE_3D ? l->maxImageDimension3D : l->maxImageDimension2D;
	out->maxExtent.width = dim;
	out->maxExtent.height = type == VK_IMAGE_TYPE_1D ? 1 : dim;
	out->maxExtent.depth = type == VK_IMAGE_TYPE_3D ? dim : 1;
	uint32_t mips = 1;
	while ((dim >> mips) > 0)
		mips++;
	out->maxMipLevels = mips;
	/* WebGPU has no 1D arrays (nor 1D mip chains) */
	out->maxArrayLayers = type == VK_IMAGE_TYPE_3D || type == VK_IMAGE_TYPE_1D ? 1 : l->maxImageArrayLayers;
	if (type == VK_IMAGE_TYPE_1D)
		out->maxMipLevels = 1;
	out->sampleCounts = VK_SAMPLE_COUNT_1_BIT;
	if (type == VK_IMAGE_TYPE_2D && (c & (4 | 16)) && !(usage & VK_IMAGE_USAGE_STORAGE_BIT))
		out->sampleCounts |= VK_SAMPLE_COUNT_4_BIT;
	out->maxResourceSize = 1ull << 31;
	return VK_SUCCESS;
}

static API void CALL kw_vkGetPhysicalDeviceSparseImageFormatProperties(VkPhysicalDevice pd, VkFormat f, VkImageType t,
	VkSampleCountFlagBits s, VkImageUsageFlags u, VkImageTiling ti, uint32_t *count, VkSparseImageFormatProperties *out)
{
	(void)pd, (void)f, (void)t, (void)s, (void)u, (void)ti, (void)out;
	*count = 0;
}

/* ---- device and queue ---- */

static API VkResult CALL kw_vkCreateDevice(VkPhysicalDevice pdh, const VkDeviceCreateInfo *ci, const VkAllocationCallbacks *a, VkDevice *out)
{
	(void)ci, (void)a;
	struct kw_physical_device *pd = PD(pdh);
	struct kw_device *d = calloc(1, sizeof *d);
	set_loader_magic_value(d);
	d->pd = pd;
	d->link = pd->inst->link;
	pthread_mutex_init(&d->mu, NULL);
	pthread_mutex_init(&d->rb_mu, NULL);
	pthread_mutex_init(&d->fl_mu, NULL);
	pthread_mutex_init(&d->q_mu, NULL);
	pthread_cond_init(&d->q_cv, NULL);
	d->held_tail = &d->held;
	const char *fs = getenv("KWVK_FENCE_SYNC");
	d->fence_sync = fs && *fs && *fs != '0';
	d->queue = calloc(1, sizeof *d->queue);
	set_loader_magic_value(d->queue);
	d->queue->dev = d;
	*out = (VkDevice)d;
	return VK_SUCCESS;
}

#define DEV(h) ((struct kw_device *)(h))

/*
 * Submits whose fences were signaled at submit: their replies are collected
 * here, an "err" one losing the device (as a failed fence wait would). Takes
 * the replies that have come; with `keep` < KW_INFLIGHT, also waits for the
 * oldest until at most `keep` are left (0: all, at vkDestroyDevice).
 */
static void inflight_reap(struct kw_device *d, int keep)
{
	pthread_mutex_lock(&d->fl_mu);
	for (;;) {
		if (!d->ninflight)
			break;
		uint32_t r = d->inflight[0];
		int must = d->ninflight > keep;
		if (!must && !link_poll(d->link, r))
			break;
		/* the oldest is answered first (the host replies to submits in order) */
		struct kw_reply *rep = link_wait(d->link, r);
		kw_reply_lost(d->link, rep, "vkQueueSubmit");
		reply_free(rep);
		memmove(d->inflight, d->inflight + 1, --d->ninflight * sizeof *d->inflight);
		if (d->link->dead) {
			d->ninflight = 0;
			break;
		}
	}
	pthread_mutex_unlock(&d->fl_mu);
}

static void held_drop_locked(struct kw_device *d);
static void tl_drop(struct kw_device *d);

static API void CALL kw_vkDestroyDevice(VkDevice dh, const VkAllocationCallbacks *a)
{
	(void)a;
	struct kw_device *d = DEV(dh);
	if (!d)
		return;
	/* submits still held for timeline values nobody signalled (the app must
	 * have waited for its work): dropped */
	pthread_mutex_lock(&d->q_mu);
	if (d->held)
		kw_log("vkDestroyDevice: submits held for timeline values never signalled are dropped");
	held_drop_locked(d);
	pthread_mutex_unlock(&d->q_mu);
	inflight_reap(d, 0);
	tl_drop(d);
	free(d->queue);
	free(d);
}

static API void CALL kw_vkGetDeviceQueue(VkDevice dh, uint32_t fam, uint32_t idx, VkQueue *out)
{
	(void)fam, (void)idx;
	*out = (VkQueue)DEV(dh)->queue;
}

/* ---- memory ---- */

static API VkResult CALL kw_vkAllocateMemory(VkDevice dh, const VkMemoryAllocateInfo *ai, const VkAllocationCallbacks *a, VkDeviceMemory *out)
{
	(void)a;
	struct kw_device *d = DEV(dh);
	if (ai->memoryTypeIndex >= d->pd->mem.memoryTypeCount)
		return VK_ERROR_OUT_OF_DEVICE_MEMORY;
	struct kw_memory *m = calloc(1, sizeof *m);
	m->type = ai->memoryTypeIndex;
	m->size = ai->allocationSize;
	if (m->type != 0 && m->size > d->pd->mem.memoryHeaps[1].size) {
		kw_err("vkAllocateMemory: %llu bytes of host-visible memory is over its heap (%llu, half the guest's RAM): VK_ERROR_OUT_OF_DEVICE_MEMORY",
		       (unsigned long long)m->size, (unsigned long long)d->pd->mem.memoryHeaps[1].size);
		free(m);
		return VK_ERROR_OUT_OF_DEVICE_MEMORY;
	}
	if (m->type != 0) {
		/* mapped pointers are aligned to minMemoryMapAlignment (64; ggml
		 * asserts on it) and more: a page */
		void *p = NULL;
		if (posix_memalign(&p, 4096, round4(m->size) + 4) == 0)
			memset(p, 0, round4(m->size) + 4);
		else
			p = NULL;
		m->shadow = p;
		if (!m->shadow) {
			free(m);
			return VK_ERROR_OUT_OF_HOST_MEMORY;
		}
	}
	pthread_mutex_lock(&d->mu);
	m->next = d->mems;
	if (d->mems)
		d->mems->prev = m;
	d->mems = m;
	pthread_mutex_unlock(&d->mu);
	*out = (VkDeviceMemory)(uintptr_t)m;
	return VK_SUCCESS;
}

static API void CALL kw_vkFreeMemory(VkDevice dh, VkDeviceMemory mh, const VkAllocationCallbacks *a)
{
	(void)a;
	struct kw_device *d = DEV(dh);
	struct kw_memory *m = HANDLE(struct kw_memory, mh);
	if (!m)
		return;
	pthread_mutex_lock(&d->mu);
	if (m->prev)
		m->prev->next = m->next;
	else
		d->mems = m->next;
	if (m->next)
		m->next->prev = m->prev;
	for (struct kw_buffer *b = d->buffers; b; b = b->next)
		if (b->mem == m)
			b->mem = NULL;
	pthread_mutex_unlock(&d->mu);
	free(m->shadow);
	free(m->sent);
	free(m);
}

static API VkResult CALL kw_vkMapMemory(VkDevice dh, VkDeviceMemory mh, VkDeviceSize off, VkDeviceSize size, VkMemoryMapFlags fl, void **pp)
{
	(void)size, (void)fl;
	struct kw_device *d = DEV(dh);
	struct kw_memory *m = HANDLE(struct kw_memory, mh);
	if (!m->shadow)
		return VK_ERROR_MEMORY_MAP_FAILED;
	kw_readback(d, m);
	if (d->link->dead) /* what the GPU wrote cannot be read back: no stale bytes */
		return VK_ERROR_MEMORY_MAP_FAILED;
	pthread_mutex_lock(&d->mu);
	if (!m->sent) {
		/* the last-sent copy lives only while mapped: the shadow equals what
		 * the host has (flushed at unmap, GPU writes read back above),
		 * except buffers bound since, which the host has zeroed */
		m->sent = malloc(round4(m->size) + 4);
		if (!m->sent) {
			pthread_mutex_unlock(&d->mu);
			return VK_ERROR_OUT_OF_HOST_MEMORY;
		}
		memcpy(m->sent, m->shadow, round4(m->size) + 4);
		for (struct kw_buffer *b = d->buffers; b; b = b->next)
			if (b->mem == m && b->fresh && b->offset < m->size) {
				uint64_t size = round4(b->size), room = round4(m->size) - b->offset;
				memset(m->sent + b->offset, 0, size < room ? size : room);
				b->fresh = 0;
			}
	}
	m->mapped = m->touched = 1;
	pthread_mutex_unlock(&d->mu);
	*pp = m->shadow + off;
	return VK_SUCCESS;
}

static API void CALL kw_vkUnmapMemory(VkDevice dh, VkDeviceMemory mh)
{
	struct kw_device *d = DEV(dh);
	struct kw_memory *m = HANDLE(struct kw_memory, mh);
	kw_flush_writes(d, m);
	pthread_mutex_lock(&d->mu);
	m->mapped = 0;
	m->touched = 0;
	free(m->sent); /* rebuilt from the shadow at the next map */
	m->sent = NULL;
	pthread_mutex_unlock(&d->mu);
}

static API VkResult CALL kw_vkFlushMappedMemoryRanges(VkDevice dh, uint32_t n, const VkMappedMemoryRange *r)
{
	for (uint32_t i = 0; i < n; i++)
		kw_flush_writes(DEV(dh), HANDLE(struct kw_memory, r[i].memory));
	return VK_SUCCESS;
}

static API VkResult CALL kw_vkInvalidateMappedMemoryRanges(VkDevice dh, uint32_t n, const VkMappedMemoryRange *r)
{
	for (uint32_t i = 0; i < n; i++)
		kw_readback(DEV(dh), HANDLE(struct kw_memory, r[i].memory));
	return DEV(dh)->link->dead ? VK_ERROR_DEVICE_LOST : VK_SUCCESS;
}

static API void CALL kw_vkGetDeviceMemoryCommitment(VkDevice d, VkDeviceMemory m, VkDeviceSize *out)
{
	(void)d;
	*out = HANDLE(struct kw_memory, m)->size;
}

/* the words of [lo, hi) of b (buffer offsets) that the CPU changed since they
 * were last sent: writeBuffer messages, then the last-sent copy updated */
static void send_diff_range(struct kw_device *d, struct kw_buffer *b, uint64_t lo, uint64_t hi)
{
	struct kw_memory *m = b->mem;
	if (!m || !m->sent || b->offset >= m->size)
		return;
	uint64_t size = round4(b->size);
	uint64_t room = round4(m->size) - b->offset;
	if (size > room)
		size = room;
	lo &= ~3ull;
	if (hi > size)
		hi = size;
	if (lo >= hi)
		return;
	uint8_t *s = m->shadow + b->offset, *t = m->sent + b->offset;
	kw_stats.scan_bytes += hi - lo;
	if (!memcmp(s + lo, t + lo, hi - lo))
		return;
	/* Unchanged words inside a span are sent too: harmless where the GPU
	 * has no write pending (the host then holds the last-sent bytes), so
	 * there spans are found in 4 KiB blocks (an upload changes every byte),
	 * else in 64-byte blocks and words. */
	size_t big = 64;
	int pending = 0;
	for (int k = 0; k < b->dirty.n && !pending; k++)
		pending = b->dirty.lo[k] < hi && b->dirty.hi[k] > lo;
	if (!pending)
		big = 4096;
	size_t i = lo;
	while (i < hi) {
		/* unchanged spans: memcmp in large steps, then words */
		if (i + 256 <= hi && !memcmp(s + i, t + i, 256)) {
			i += 256;
			continue;
		}
		if (!memcmp(s + i, t + i, 4)) {
			i += 4;
			continue;
		}
		/* a changed span ends after more than 256 unchanged bytes */
		size_t start = i, last = i;
		for (i += 4; i < hi;) {
			size_t step = !(i & (big - 1)) && hi - i >= big ? big : !(i & 63) && hi - i >= 64 ? 64 : 4;
			if (memcmp(s + i, t + i, step))
				last = i + step - 4;
			else if (i + step - 4 - last > 256)
				break;
			i += step;
		}
		size_t end = last + 4;
		/* frames stay well under the host's 256 MiB cap */
		for (size_t o = start; o < end; o += 16u << 20) {
			size_t len = end - o < (16u << 20) ? end - o : (16u << 20);
			struct jb j = {0};
			jb_printf(&j, "{\"op\":\"writeBuffer\",\"buffer\":%u,\"offset\":%zu}", b->id, o);
			link_send(d->link, &j, s + o, len, 0);
			jb_free(&j);
			kw_stats.write_bytes += len;
			kw_stats.writes++;
		}
		memcpy(t + start, s + start, end - start);
		i = end;
	}
}

static void send_diff(struct kw_device *d, struct kw_buffer *b) { send_diff_range(d, b, 0, UINT64_MAX); }

/* with d->mu held */
static void flush_locked(struct kw_device *d, struct kw_memory *only)
{
	for (struct kw_buffer *b = d->buffers; b; b = b->next)
		if (b->mem && b->mem->touched && (!only || b->mem == only))
			send_diff(d, b);
	for (struct kw_memory *m = d->mems; m; m = m->next)
		if (!m->mapped && (!only || m == only))
			m->touched = 0;
}

void kw_flush_writes(struct kw_device *d, struct kw_memory *only)
{
	int64_t t0 = kw_now();
	pthread_mutex_lock(&d->mu);
	flush_locked(d, only);
	pthread_mutex_unlock(&d->mu);
	kw_stats.flush_ns += kw_now() - t0;
}

/* with d->mu held: at vkQueueSubmit, only what its commands may read or
 * write (vk/PROTOCOL.md, Amendments, "Submit flush") */
static void flush_list(struct kw_device *d, const struct kw_written *l, size_t n)
{
	for (size_t i = 0; i < n; i++) {
		struct kw_buffer *b = l[i].buf;
		/* the buffer may have been destroyed since recording: check it is listed */
		struct kw_buffer *x = d->buffers;
		while (x && x != b)
			x = x->next;
		if (!x || !b->mem || !b->mem->touched)
			continue;
		for (int q = 0; q < l[i].r.n; q++)
			send_diff_range(d, b, l[i].r.lo[q], l[i].r.hi[q]);
	}
}

void kw_ranges_add(struct kw_ranges *r, VkDeviceSize lo, VkDeviceSize hi)
{
	if (lo >= hi)
		return;
	int n = r->n, i = n;
	while (i > 0 && r->lo[i - 1] > lo) { /* keep them sorted by lo */
		r->lo[i] = r->lo[i - 1];
		r->hi[i] = r->hi[i - 1];
		i--;
	}
	r->lo[i] = lo;
	r->hi[i] = hi;
	n++;
	int k = 0; /* join overlapping or adjacent neighbours */
	for (int j = 1; j < n; j++) {
		if (r->lo[j] <= r->hi[k]) {
			if (r->hi[j] > r->hi[k])
				r->hi[k] = r->hi[j];
		} else {
			k++;
			r->lo[k] = r->lo[j];
			r->hi[k] = r->hi[j];
		}
	}
	n = k + 1;
	if (n > KW_MAX_RANGES) { /* too many: join the two closest (never less than the writes) */
		int best = 0;
		for (int j = 1; j + 1 < n; j++)
			if (r->lo[j + 1] - r->hi[j] < r->lo[best + 1] - r->hi[best])
				best = j;
		r->hi[best] = r->hi[best + 1];
		for (int j = best + 1; j + 1 < n; j++) {
			r->lo[j] = r->lo[j + 1];
			r->hi[j] = r->hi[j + 1];
		}
		n--;
	}
	r->n = n;
}

/*
 * Bytes read back into a mapped shadow: a word the CPU changed since the
 * last flush (the shadow differs from the last-sent copy) keeps the CPU's
 * value, as the GPU cannot have written it too (that would be a data race
 * the app may not have); the next flush sends it. Unmapped memory (no
 * last-sent copy) has no CPU writes.
 */
static void merge_read(uint8_t *shadow, uint8_t *sent, const uint8_t *bin, size_t n)
{
	if (!sent) {
		memcpy(shadow, bin, n);
		return;
	}
	size_t i = 0;
	/* blocks the CPU left alone (the usual case) at memcmp/memcpy speed */
	for (; i + 4 <= n;) {
		size_t blk = n - i >= 4096 ? 4096 : (n - i) & ~(size_t)3;
		if (blk >= 64 && !memcmp(shadow + i, sent + i, blk)) {
			memcpy(shadow + i, bin + i, blk);
			memcpy(sent + i, bin + i, blk);
			i += blk;
			continue;
		}
		size_t e = i + (blk < 64 ? blk : 64);
		for (; i < e; i += 4) {
			if (!memcmp(shadow + i, sent + i, 4))
				memcpy(shadow + i, bin + i, 4);
			memcpy(sent + i, bin + i, 4);
		}
	}
	for (; i < n; i++) {
		if (shadow[i] == sent[i])
			shadow[i] = bin[i];
		sent[i] = bin[i];
	}
}

void kw_readback(struct kw_device *d, struct kw_memory *only)
{
	enum { MAXR = 64 };
	struct kw_buffer *bs[MAXR];
	uint32_t rs[MAXR];
	uint64_t offs[MAXR];
	int64_t t0 = kw_now();
	/* one readback at a time: a thread that finds nothing marked must not
	 * read its shadow while another thread's readback of it is in flight */
	pthread_mutex_lock(&d->rb_mu);
	for (;;) {
		int n = 0, more = 0;
		pthread_mutex_lock(&d->mu);
		for (struct kw_buffer *b = d->buffers; b; b = b->next) {
			/* without `only` (a wait), read back only what is mapped now:
			 * the rest stays dirty until vkMapMemory reads it */
			if (!b->dirty.n || !b->mem || !b->mem->shadow || (only ? b->mem != only : !b->mem->mapped))
				continue;
			if (n + b->dirty.n > MAXR) {
				more = 1;
				break;
			}
			struct kw_ranges r = b->dirty;
			b->dirty.n = 0;
			if (b->offset >= b->mem->size)
				continue;
			/* only the ranges submitted work may have written (vk/PROTOCOL.md) */
			uint64_t size = (b->size + 3) & ~3ull, room = round4(b->mem->size) - b->offset;
			if (size > room)
				size = room;
			for (int k = 0; k < r.n; k++) {
				uint64_t lo = r.lo[k] & ~3ull, hi = r.hi[k] < size ? (r.hi[k] + 3) & ~3ull : size;
				if (hi > size)
					hi = size;
				if (lo >= hi)
					continue;
				struct jb j = {0};
				jb_printf(&j, "{\"op\":\"readBuffer\",\"buffer\":%u,\"offset\":%llu,\"size\":%llu}", b->id, (unsigned long long)lo,
					  (unsigned long long)(hi - lo));
				bs[n] = b;
				offs[n] = lo;
				rs[n++] = link_send(d->link, &j, NULL, 0, 1);
				jb_free(&j);
			}
		}
		pthread_mutex_unlock(&d->mu);
		if (!n && !more)
			break;
		for (int i = 0; i < n; i++) {
			struct kw_reply *rep = link_wait(d->link, rs[i]);
			/* the shadow would keep stale bytes: the device is lost instead */
			if (kw_reply_lost(d->link, rep, "reading back a buffer the GPU wrote")) {
				reply_free(rep);
				more = 0;
				break;
			}
			kw_stats.read_bytes += rep->binlen;
			pthread_mutex_lock(&d->mu);
			struct kw_buffer *b = bs[i];
			/* the buffer may have been destroyed meanwhile: check it is listed */
			struct kw_buffer *x = d->buffers;
			while (x && x != b)
				x = x->next;
			if (x && b->mem && rep->bin && b->offset + offs[i] < round4(b->mem->size)) {
				uint64_t at = b->offset + offs[i], room = round4(b->mem->size) - at;
				size_t n2 = rep->binlen < room ? rep->binlen : room;
				merge_read(b->mem->shadow + at, b->mem->sent ? b->mem->sent + at : NULL, rep->bin, n2);
			}
			pthread_mutex_unlock(&d->mu);
			reply_free(rep);
		}
		if (!more || d->link->dead)
			break;
	}
	pthread_mutex_unlock(&d->rb_mu);
	kw_stats.readback_ns += kw_now() - t0;
}

/* ---- buffers ---- */

static API VkResult CALL kw_vkCreateBuffer(VkDevice dh, const VkBufferCreateInfo *ci, const VkAllocationCallbacks *a, VkBuffer *out)
{
	(void)a;
	struct kw_device *d = DEV(dh);
	if (ci->size > d->pd->max_buffer) {
		kw_err("vkCreateBuffer: %llu bytes is over the device's maxBufferSize (%llu): VK_ERROR_OUT_OF_DEVICE_MEMORY",
		       (unsigned long long)ci->size, (unsigned long long)d->pd->max_buffer);
		return VK_ERROR_OUT_OF_DEVICE_MEMORY;
	}
	struct kw_buffer *b = calloc(1, sizeof *b);
	b->id = link_id(d->link);
	b->size = ci->size;
	b->usage = ci->usage;
	struct jb j = {0};
	jb_printf(&j, "{\"op\":\"vkCreateBuffer\",\"id\":%u,\"size\":%llu,\"usage\":%u}", b->id, (unsigned long long)ci->size, ci->usage);
	send_msg(d, &j, NULL, 0);
	pthread_mutex_lock(&d->mu);
	b->next = d->buffers;
	if (d->buffers)
		d->buffers->prev = b;
	d->buffers = b;
	pthread_mutex_unlock(&d->mu);
	*out = (VkBuffer)(uintptr_t)b;
	return VK_SUCCESS;
}

static API void CALL kw_vkDestroyBuffer(VkDevice dh, VkBuffer bh, const VkAllocationCallbacks *a)
{
	(void)a;
	struct kw_device *d = DEV(dh);
	struct kw_buffer *b = HANDLE(struct kw_buffer, bh);
	if (!b)
		return;
	pthread_mutex_lock(&d->mu);
	if (b->prev)
		b->prev->next = b->next;
	else
		d->buffers = b->next;
	if (b->next)
		b->next->prev = b->prev;
	pthread_mutex_unlock(&d->mu);
	destroy_id(d, b->id);
	free(b);
}

static API void CALL kw_vkGetBufferMemoryRequirements(VkDevice d, VkBuffer bh, VkMemoryRequirements *r)
{
	(void)d;
	struct kw_buffer *b = HANDLE(struct kw_buffer, bh);
	r->alignment = 256;
	r->size = (round4(b->size) + 255) & ~255ull;
	r->memoryTypeBits = 3;
}

static API VkResult CALL kw_vkBindBufferMemory(VkDevice dh, VkBuffer bh, VkDeviceMemory mh, VkDeviceSize off)
{
	struct kw_device *d = DEV(dh);
	struct kw_buffer *b = HANDLE(struct kw_buffer, bh);
	struct kw_memory *m = HANDLE(struct kw_memory, mh);
	pthread_mutex_lock(&d->mu);
	b->mem = m;
	b->offset = off;
	b->fresh = !m->sent;
	if (m->sent && off < m->size) {
		/* the host buffer starts zeroed: make the diff send what is there */
		uint64_t size = round4(b->size), room = round4(m->size) - off;
		memset(m->sent + off, 0, size < room ? size : room);
		m->touched = 1;
	}
	pthread_mutex_unlock(&d->mu);
	return VK_SUCCESS;
}

static API void CALL kw_vkGetImageMemoryRequirements(VkDevice d, VkImage i, VkMemoryRequirements *r);
static API void CALL kw_vkGetDeviceQueue(VkDevice dh, uint32_t fam, uint32_t idx, VkQueue *out);

/* Vulkan 1.1 entry points with a trivial 1.0 mapping (pNext ignored), so
 * an app that calls them through the loader's trampolines finds them */
static API void CALL kw_vkGetBufferMemoryRequirements2(VkDevice d, const VkBufferMemoryRequirementsInfo2 *i, VkMemoryRequirements2 *r)
{
	kw_vkGetBufferMemoryRequirements(d, i->buffer, &r->memoryRequirements);
}
static API void CALL kw_vkGetImageMemoryRequirements2(VkDevice d, const VkImageMemoryRequirementsInfo2 *i, VkMemoryRequirements2 *r)
{
	kw_vkGetImageMemoryRequirements(d, i->image, &r->memoryRequirements);
}
static API void CALL kw_vkGetImageSparseMemoryRequirements2(VkDevice d, const VkImageSparseMemoryRequirementsInfo2 *i, uint32_t *n, VkSparseImageMemoryRequirements2 *r)
{
	(void)d, (void)i, (void)r;
	*n = 0;
}
static API VkResult CALL kw_vkBindBufferMemory2(VkDevice d, uint32_t n, const VkBindBufferMemoryInfo *b)
{
	for (uint32_t i = 0; i < n; i++)
		kw_vkBindBufferMemory(d, b[i].buffer, b[i].memory, b[i].memoryOffset);
	return VK_SUCCESS;
}
static API VkResult CALL kw_vkBindImageMemory2(VkDevice d, uint32_t n, const VkBindImageMemoryInfo *b)
{
	(void)d, (void)n, (void)b;
	return VK_SUCCESS;
}
static API void CALL kw_vkGetDeviceQueue2(VkDevice d, const VkDeviceQueueInfo2 *i, VkQueue *q)
{
	kw_vkGetDeviceQueue(d, i->queueFamilyIndex, i->queueIndex, q);
}

/* ---- images ---- */

uint32_t kw_create_image_msg(struct kw_device *d, const VkImageCreateInfo *ci)
{
	uint32_t id = link_id(d->link);
	struct jb j = {0};
	jb_printf(&j, "{\"op\":\"vkCreateImage\",\"id\":%u,\"flags\":%u,\"imageType\":%u,\"format\":%u,\"extent\":", id,
		  ci->flags, ci->imageType, ci->format);
	j_ext3(&j, ci->extent);
	jb_printf(&j, ",\"mipLevels\":%u,\"arrayLayers\":%u,\"samples\":%u,\"tiling\":%u,\"usage\":%u,\"sharingMode\":%u,\"initialLayout\":%u}",
		  ci->mipLevels, ci->arrayLayers, ci->samples, ci->tiling, ci->usage, ci->sharingMode, ci->initialLayout);
	send_msg(d, &j, NULL, 0);
	return id;
}

static API VkResult CALL kw_vkCreateImage(VkDevice dh, const VkImageCreateInfo *ci, const VkAllocationCallbacks *a, VkImage *out)
{
	(void)a;
	struct kw_device *d = DEV(dh);
	uint32_t caps = ci->format > 0 && ci->format < 256 ? d->pd->fmtcaps[ci->format] : 0;
	if (!(caps & ~64u)) { /* the host has no texture format for it */
		kw_err("vkCreateImage: format %u is not supported (no format features): VK_ERROR_FORMAT_NOT_SUPPORTED", ci->format);
		return VK_ERROR_FORMAT_NOT_SUPPORTED;
	}
	/* kept working as optimal (right while the app only renders to, copies
	 * or samples it), but the memory the CPU maps is not the texels */
	if (ci->tiling != VK_IMAGE_TILING_OPTIMAL)
		kw_err("vkCreateImage: linear tiling is unsupported (treated as optimal): the image's bound memory does not hold its texels");
	struct kw_image *im = calloc(1, sizeof *im);
	im->id = kw_create_image_msg(d, ci);
	im->format = ci->format;
	im->extent = ci->extent;
	*out = (VkImage)(uintptr_t)im;
	return VK_SUCCESS;
}

static API void CALL kw_vkDestroyImage(VkDevice dh, VkImage ih, const VkAllocationCallbacks *a)
{
	(void)a;
	struct kw_image *im = HANDLE(struct kw_image, ih);
	if (!im || im->swapchain)
		return;
	destroy_id(DEV(dh), im->id);
	free(im);
}

static API void CALL kw_vkGetImageMemoryRequirements(VkDevice d, VkImage i, VkMemoryRequirements *r)
{
	(void)d, (void)i;
	r->size = 256;
	r->alignment = 256;
	r->memoryTypeBits = 3;
}

static API VkResult CALL kw_vkBindImageMemory(VkDevice d, VkImage i, VkDeviceMemory m, VkDeviceSize o)
{
	(void)d, (void)i, (void)m, (void)o;
	return VK_SUCCESS;
}

static API void CALL kw_vkGetImageSubresourceLayout(VkDevice d, VkImage ih, const VkImageSubresource *s, VkSubresourceLayout *l)
{
	(void)d, (void)s;
	struct kw_image *im = HANDLE(struct kw_image, ih);
	memset(l, 0, sizeof *l);
	l->rowPitch = im->extent.width * 4;
	l->size = l->rowPitch * im->extent.height;
	l->depthPitch = l->arrayPitch = l->size;
}

static API void CALL kw_vkGetImageSparseMemoryRequirements(VkDevice d, VkImage i, uint32_t *n, VkSparseImageMemoryRequirements *r)
{
	(void)d, (void)i, (void)r;
	*n = 0;
}

/* generic host object */
static struct kw_obj *new_obj(struct kw_device *d)
{
	struct kw_obj *o = calloc(1, sizeof *o);
	o->id = link_id(d->link);
	return o;
}
static void destroy_obj(VkDevice dh, uint64_t h)
{
	struct kw_obj *o = HANDLE(struct kw_obj, h);
	if (!o)
		return;
	destroy_id(DEV(dh), o->id);
	free(o);
}

#define DESTROY_FN(name, T)                                                                  \
	static API void CALL kw_vkDestroy##name(VkDevice d, T h, const VkAllocationCallbacks *a) \
	{                                                                                        \
		(void)a;                                                                         \
		destroy_obj(d, (uint64_t)(uintptr_t)h);                                          \
	}

static API VkResult CALL kw_vkCreateImageView(VkDevice dh, const VkImageViewCreateInfo *ci, const VkAllocationCallbacks *a, VkImageView *out)
{
	(void)a;
	struct kw_device *d = DEV(dh);
	struct kw_obj *o = new_obj(d);
	struct jb j = {0};
	jb_printf(&j, "{\"op\":\"vkCreateImageView\",\"id\":%u,\"flags\":%u,\"image\":%u,\"viewType\":%u,\"format\":%u,"
		      "\"components\":{\"r\":%u,\"g\":%u,\"b\":%u,\"a\":%u},\"subresourceRange\":",
		  o->id, ci->flags, oid((uint64_t)(uintptr_t)ci->image), ci->viewType, ci->format, ci->components.r,
		  ci->components.g, ci->components.b, ci->components.a);
	j_range(&j, &ci->subresourceRange);
	JS(&j, "}");
	send_msg(d, &j, NULL, 0);
	*out = (VkImageView)(uintptr_t)o;
	return VK_SUCCESS;
}
DESTROY_FN(ImageView, VkImageView)

/* texel buffer views: made on the host (a storage binding of the buffer and
 * the shader's parameters: vk/PROTOCOL.md, Amendments, "Texel buffers");
 * kept here for the device memory tracking of the sets they are written to.
 * A format the host does not list for the buffer's texel usages is refused. */
static API VkResult CALL kw_vkCreateBufferView(VkDevice dh, const VkBufferViewCreateInfo *ci, const VkAllocationCallbacks *a, VkBufferView *out)
{
	(void)a;
	struct kw_device *d = DEV(dh);
	struct kw_buffer *b = HANDLE(struct kw_buffer, ci->buffer);
	uint8_t t = ci->format > 0 && ci->format < 256 ? d->pd->texelcaps[ci->format] : 0;
	int need = (b && (b->usage & VK_BUFFER_USAGE_UNIFORM_TEXEL_BUFFER_BIT) ? 1 : 0) |
		   (b && (b->usage & VK_BUFFER_USAGE_STORAGE_TEXEL_BUFFER_BIT) ? 2 : 0);
	if (!b || !t || (need & ~t)) {
		kw_err("vkCreateBufferView: format %u is not supported for %s texel buffers: VK_ERROR_FORMAT_NOT_SUPPORTED", ci->format,
		       (need & ~t) == 2 ? "storage" : (need & ~t) == 1 ? "uniform" : "any");
		return VK_ERROR_FORMAT_NOT_SUPPORTED;
	}
	struct kw_bview *o = calloc(1, sizeof *o);
	o->id = link_id(d->link);
	o->buf = b;
	o->offset = ci->offset;
	o->range = ci->range;
	struct jb j = {0};
	jb_printf(&j, "{\"op\":\"vkCreateBufferView\",\"id\":%u,\"buffer\":%u,\"format\":%u,\"offset\":%llu,\"range\":", o->id,
		  b->id, ci->format, (unsigned long long)ci->offset);
	j_size(&j, ci->range);
	JS(&j, "}");
	send_msg(d, &j, NULL, 0);
	*out = (VkBufferView)(uintptr_t)o;
	return VK_SUCCESS;
}
DESTROY_FN(BufferView, VkBufferView)

static API VkResult CALL kw_vkCreateSampler(VkDevice dh, const VkSamplerCreateInfo *ci, const VkAllocationCallbacks *a, VkSampler *out)
{
	(void)a;
	struct kw_device *d = DEV(dh);
	struct kw_obj *o = new_obj(d);
	struct jb j = {0};
	jb_printf(&j, "{\"op\":\"vkCreateSampler\",\"id\":%u,\"flags\":%u,\"magFilter\":%u,\"minFilter\":%u,\"mipmapMode\":%u,"
		      "\"addressModeU\":%u,\"addressModeV\":%u,\"addressModeW\":%u,\"mipLodBias\":",
		  o->id, ci->flags, ci->magFilter, ci->minFilter, ci->mipmapMode, ci->addressModeU, ci->addressModeV, ci->addressModeW);
	jb_float(&j, ci->mipLodBias);
	jb_printf(&j, ",\"anisotropyEnable\":%u,\"maxAnisotropy\":", ci->anisotropyEnable);
	jb_float(&j, ci->maxAnisotropy);
	jb_printf(&j, ",\"compareEnable\":%u,\"compareOp\":%u,\"minLod\":", ci->compareEnable, ci->compareOp);
	jb_float(&j, ci->minLod);
	JS(&j, ",\"maxLod\":");
	jb_float(&j, ci->maxLod);
	jb_printf(&j, ",\"borderColor\":%u,\"unnormalizedCoordinates\":%u}", ci->borderColor, ci->unnormalizedCoordinates);
	send_msg(d, &j, NULL, 0);
	*out = (VkSampler)(uintptr_t)o;
	return VK_SUCCESS;
}
DESTROY_FN(Sampler, VkSampler)

/* (set << 16 | binding) of the storage buffers and storage texel buffers
 * (imageBuffer) a SPIR-V module may write: not NonWritable (on the variable
 * or on every member of its block). Only those are marked GPU-written at a
 * draw or dispatch. -1 when unsure. */
static int spirv_writable(const uint32_t *w, size_t nw, uint32_t *out, int cap)
{
	if (nw < 5 || w[0] != 0x07230203)
		return -1;
	uint32_t bound = w[3];
	if (bound > (1u << 22))
		return -1;
	uint8_t *nonwr = calloc(bound, 1);   /* var or struct: NonWritable seen */
	uint16_t *mnw = calloc(bound, 2);    /* struct: members decorated NonWritable */
	uint16_t *mcount = calloc(bound, 2); /* struct: member count */
	uint8_t *bufblock = calloc(bound, 1);
	uint8_t *imgbuf = calloc(bound, 1); /* OpTypeImage Dim Buffer, not known sampled */
	uint32_t *set = calloc(bound, 4), *bind = calloc(bound, 4), *ptr = calloc(bound, 4), *inner = calloc(bound, 4);
	uint8_t *hasset = calloc(bound, 1), *hasbind = calloc(bound, 1);
	uint32_t *vars = calloc(bound, 4), *varsc = calloc(bound, 4), *ptrsc = calloc(bound, 4);
	int n = 0, nvars = 0, bad = !nonwr || !mnw || !mcount || !bufblock || !set || !bind || !ptr || !inner || !hasset || !hasbind || !vars || !varsc || !ptrsc || !imgbuf;
	for (size_t i = 5; !bad && i < nw;) {
		uint32_t op = w[i] & 0xffff, len = w[i] >> 16;
		if (!len || i + len > nw) {
			bad = 1;
			break;
		}
		const uint32_t *a = w + i + 1;
#define ID(x) ((x) < bound)
		if (op == 71 && len >= 3 && ID(a[0])) { /* OpDecorate */
			if (a[1] == 24)
				nonwr[a[0]] = 1;
			else if (a[1] == 3)
				bufblock[a[0]] = 1;
			else if (a[1] == 34 && len >= 4)
				set[a[0]] = a[2], hasset[a[0]] = 1;
			else if (a[1] == 33 && len >= 4)
				bind[a[0]] = a[2], hasbind[a[0]] = 1;
		} else if (op == 72 && len >= 4 && ID(a[0]) && a[2] == 24) { /* OpMemberDecorate NonWritable */
			mnw[a[0]]++;
		} else if (op == 25 && len >= 9 && ID(a[0])) { /* OpTypeImage: Dim Buffer, Sampled 0 or 2 */
			imgbuf[a[0]] = a[2] == 5 && a[6] != 1;
		} else if (op == 30 && len >= 2 && ID(a[0])) { /* OpTypeStruct */
			mcount[a[0]] = (uint16_t)(len - 2);
		} else if ((op == 28 || op == 29) && len >= 3 && ID(a[0]) && ID(a[1])) { /* OpTypeArray/RuntimeArray */
			inner[a[0]] = a[1];
		} else if (op == 32 && len >= 4 && ID(a[0]) && ID(a[2])) { /* OpTypePointer */
			ptr[a[0]] = a[2];
			ptrsc[a[0]] = a[1];
		} else if (op == 59 && len >= 4 && ID(a[0]) && ID(a[1])) { /* OpVariable */
			vars[nvars] = a[1];
			varsc[nvars++] = a[0];
		}
		i += len;
	}
	for (int k = 0; !bad && k < nvars; k++) {
		uint32_t v = vars[k], pt = varsc[k], sc = ptrsc[pt], ty = ptr[pt];
		if (inner[ty])
			ty = inner[ty];
		if (sc != 12 && !(sc == 2 && bufblock[ty]) && !(sc == 0 && imgbuf[ty]))
			continue; /* not a storage buffer or storage texel buffer */
		if (nonwr[v] || (mcount[ty] && mnw[ty] >= mcount[ty]))
			continue; /* read-only */
		if (!hasset[v] || !hasbind[v] || n >= cap) {
			bad = 1;
			break;
		}
		out[n++] = set[v] << 16 | (bind[v] & 0xffff);
	}
#undef ID
	free(nonwr), free(mnw), free(mcount), free(bufblock), free(imgbuf), free(set), free(bind), free(ptr), free(inner);
	free(hasset), free(hasbind), free(vars), free(varsc), free(ptrsc);
	return bad ? -1 : n;
}

/* does the module decorate anything BuiltIn BaseVertex (4424), BaseInstance
 * (4425) or DrawIndex (4426)? WGSL has none: the translator reads 0 */
static int spirv_base(const uint32_t *w, size_t nw)
{
	if (nw < 5 || w[0] != 0x07230203)
		return 0;
	for (size_t i = 5; i < nw;) {
		uint32_t op = w[i] & 0xffff, len = w[i] >> 16;
		if (!len || i + len > nw)
			return 0;
		if (op == 71 && len >= 4 && w[i + 2] == 11 && w[i + 3] >= 4424 && w[i + 3] <= 4426)
			return 1;
		if (op == 72 && len >= 5 && w[i + 3] == 11 && w[i + 4] >= 4424 && w[i + 4] <= 4426)
			return 1;
		if (op == 54) /* OpFunction: past the annotations */
			return 0;
		i += len;
	}
	return 0;
}

static API VkResult CALL kw_vkCreateShaderModule(VkDevice dh, const VkShaderModuleCreateInfo *ci, const VkAllocationCallbacks *a, VkShaderModule *out)
{
	(void)a;
	struct kw_device *d = DEV(dh);
	uint32_t tmp[64];
	int nw = spirv_writable(ci->pCode, ci->codeSize / 4, tmp, 64);
	struct kw_shader *o = calloc(1, sizeof *o + (nw > 0 ? nw : 0) * sizeof(uint32_t));
	o->id = link_id(d->link);
	o->nw = nw;
	o->base = spirv_base(ci->pCode, ci->codeSize / 4);
	if (nw > 0)
		memcpy(o->w, tmp, nw * sizeof(uint32_t));
	struct jb j = {0};
	jb_printf(&j, "{\"op\":\"vkCreateShaderModule\",\"id\":%u}", o->id);
	const char *dir = getenv("KWVK_SPIRV_DIR"); /* debugging: keep every module as DIR/ID.spv */
	if (dir && *dir) {
		char path[4096];
		snprintf(path, sizeof path, "%s/%u.spv", dir, o->id);
		FILE *f = fopen(path, "wb");
		if (f) {
			fwrite(ci->pCode, 1, ci->codeSize, f);
			fclose(f);
		}
	}
	send_msg(d, &j, ci->pCode, ci->codeSize);
	*out = (VkShaderModule)(uintptr_t)o;
	return VK_SUCCESS;
}

/* a pipeline's writable storage bindings: the union over its stages (nw -1: unknown) */
static struct kw_pipe *new_pipe(struct kw_device *d, const VkPipelineShaderStageCreateInfo *st, uint32_t n)
{
	int total = 0;
	for (uint32_t i = 0; i < n; i++) {
		struct kw_shader *m = HANDLE(struct kw_shader, st[i].module);
		if (!m || m->nw < 0) {
			total = -1;
			break;
		}
		total += m->nw;
	}
	struct kw_pipe *p = calloc(1, sizeof *p + (total > 0 ? total : 0) * sizeof(uint32_t));
	p->id = link_id(d->link);
	p->nw = total;
	for (uint32_t i = 0; i < n; i++) {
		struct kw_shader *m = HANDLE(struct kw_shader, st[i].module);
		if (m && m->base)
			p->base = 1;
	}
	if (total > 0) {
		int k = 0;
		for (uint32_t i = 0; i < n; i++) {
			struct kw_shader *m = HANDLE(struct kw_shader, st[i].module);
			memcpy(p->w + k, m->w, m->nw * sizeof(uint32_t));
			k += m->nw;
		}
	}
	return p;
}

DESTROY_FN(ShaderModule, VkShaderModule)

static int dsl_cmp(const void *a, const void *b)
{
	uint32_t x = ((const struct kw_dsl_binding *)a)->binding, y = ((const struct kw_dsl_binding *)b)->binding;
	return x < y ? -1 : x > y;
}

static void dsl_unref(struct kw_dsl *l)
{
	if (l && __atomic_sub_fetch(&l->refs, 1, __ATOMIC_ACQ_REL) == 0)
		free(l);
}

static API VkResult CALL kw_vkCreateDescriptorSetLayout(VkDevice dh, const VkDescriptorSetLayoutCreateInfo *ci, const VkAllocationCallbacks *a, VkDescriptorSetLayout *out)
{
	(void)a;
	struct kw_device *d = DEV(dh);
	struct kw_dsl *o = calloc(1, sizeof *o + ci->bindingCount * sizeof o->b[0]);
	if (!o)
		return VK_ERROR_OUT_OF_HOST_MEMORY;
	o->id = link_id(d->link);
	o->refs = 1;
	o->n = ci->bindingCount;
	for (uint32_t i = 0; i < ci->bindingCount; i++)
		o->b[i] = (struct kw_dsl_binding){ci->pBindings[i].binding, ci->pBindings[i].descriptorType, ci->pBindings[i].descriptorCount, 0};
	qsort(o->b, o->n, sizeof o->b[0], dsl_cmp);
	/* dynamic offsets come in binding order, one per array element (as the host counts them) */
	for (uint32_t i = 0, ndyn = 0; i < o->n; i++) {
		o->b[i].dyn = ndyn;
		if (o->b[i].type == VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER_DYNAMIC || o->b[i].type == VK_DESCRIPTOR_TYPE_STORAGE_BUFFER_DYNAMIC)
			ndyn += o->b[i].count;
	}
	struct jb j = {0};
	jb_printf(&j, "{\"op\":\"vkCreateDescriptorSetLayout\",\"id\":%u,\"flags\":%u,\"bindings\":[", o->id, ci->flags);
	for (uint32_t i = 0; i < ci->bindingCount; i++) {
		const VkDescriptorSetLayoutBinding *b = &ci->pBindings[i];
		jb_printf(&j, "%s{\"binding\":%u,\"descriptorType\":%u,\"descriptorCount\":%u,\"stageFlags\":%u", i ? "," : "",
			  b->binding, b->descriptorType, b->descriptorCount, b->stageFlags);
		if (b->pImmutableSamplers && (b->descriptorType == VK_DESCRIPTOR_TYPE_SAMPLER ||
					      b->descriptorType == VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER)) {
			JS(&j, ",\"immutableSamplers\":[");
			for (uint32_t k = 0; k < b->descriptorCount; k++)
				jb_printf(&j, k ? ",%u" : "%u", oid((uint64_t)(uintptr_t)b->pImmutableSamplers[k]));
			JS(&j, "]");
		}
		JS(&j, "}");
	}
	JS(&j, "]}");
	send_msg(d, &j, NULL, 0);
	*out = (VkDescriptorSetLayout)(uintptr_t)o;
	return VK_SUCCESS;
}
static API void CALL kw_vkDestroyDescriptorSetLayout(VkDevice d, VkDescriptorSetLayout h, const VkAllocationCallbacks *a)
{
	(void)a;
	struct kw_dsl *l = HANDLE(struct kw_dsl, h);
	if (!l)
		return;
	destroy_id(DEV(d), l->id);
	dsl_unref(l); /* its sets keep the binding table */
}

static API VkResult CALL kw_vkCreatePipelineLayout(VkDevice dh, const VkPipelineLayoutCreateInfo *ci, const VkAllocationCallbacks *a, VkPipelineLayout *out)
{
	(void)a;
	if (ci->pushConstantRangeCount && ci->setLayoutCount >= kw_bind_groups) {
		kw_err("vkCreatePipelineLayout: %u sets with push constants need %u bind groups, the host has %u: VK_ERROR_FEATURE_NOT_PRESENT",
		       ci->setLayoutCount, ci->setLayoutCount + 1, kw_bind_groups);
		return VK_ERROR_FEATURE_NOT_PRESENT;
	}
	struct kw_device *d = DEV(dh);
	struct kw_obj *o = new_obj(d);
	struct jb j = {0};
	jb_printf(&j, "{\"op\":\"vkCreatePipelineLayout\",\"id\":%u,\"setLayouts\":[", o->id);
	for (uint32_t i = 0; i < ci->setLayoutCount; i++)
		jb_printf(&j, i ? ",%u" : "%u", oid((uint64_t)(uintptr_t)ci->pSetLayouts[i]));
	JS(&j, "],\"pushConstantRanges\":[");
	for (uint32_t i = 0; i < ci->pushConstantRangeCount; i++)
		jb_printf(&j, "%s{\"stageFlags\":%u,\"offset\":%u,\"size\":%u}", i ? "," : "", ci->pPushConstantRanges[i].stageFlags,
			  ci->pPushConstantRanges[i].offset, ci->pPushConstantRanges[i].size);
	JS(&j, "]}");
	send_msg(d, &j, NULL, 0);
	*out = (VkPipelineLayout)(uintptr_t)o;
	return VK_SUCCESS;
}
DESTROY_FN(PipelineLayout, VkPipelineLayout)

static void j_attref(struct jb *j, const VkAttachmentReference *r)
{
	jb_printf(j, "{\"attachment\":%u,\"layout\":%u}", r->attachment, r->layout);
}
static void j_attrefs(struct jb *j, const char *name, const VkAttachmentReference *r, uint32_t n)
{
	jb_printf(j, ",\"%s\":[", name);
	for (uint32_t i = 0; i < n; i++) {
		if (i)
			JS(j, ",");
		j_attref(j, &r[i]);
	}
	JS(j, "]");
}

static API VkResult CALL kw_vkCreateRenderPass(VkDevice dh, const VkRenderPassCreateInfo *ci, const VkAllocationCallbacks *a, VkRenderPass *out)
{
	(void)a;
	struct kw_device *d = DEV(dh);
	struct kw_obj *o = new_obj(d);
	struct jb j = {0};
	jb_printf(&j, "{\"op\":\"vkCreateRenderPass\",\"id\":%u,\"attachments\":[", o->id);
	for (uint32_t i = 0; i < ci->attachmentCount; i++) {
		const VkAttachmentDescription *x = &ci->pAttachments[i];
		jb_printf(&j, "%s{\"flags\":%u,\"format\":%u,\"samples\":%u,\"loadOp\":%u,\"storeOp\":%u,\"stencilLoadOp\":%u,"
			      "\"stencilStoreOp\":%u,\"initialLayout\":%u,\"finalLayout\":%u}",
			  i ? "," : "", x->flags, x->format, x->samples, x->loadOp, x->storeOp, x->stencilLoadOp, x->stencilStoreOp,
			  x->initialLayout, x->finalLayout);
	}
	JS(&j, "],\"subpasses\":[");
	for (uint32_t i = 0; i < ci->subpassCount; i++) {
		const VkSubpassDescription *s = &ci->pSubpasses[i];
		jb_printf(&j, "%s{\"flags\":%u,\"pipelineBindPoint\":%u", i ? "," : "", s->flags, s->pipelineBindPoint);
		j_attrefs(&j, "inputAttachments", s->pInputAttachments, s->inputAttachmentCount);
		j_attrefs(&j, "colorAttachments", s->pColorAttachments, s->colorAttachmentCount);
		if (s->pResolveAttachments)
			j_attrefs(&j, "resolveAttachments", s->pResolveAttachments, s->colorAttachmentCount);
		if (s->pDepthStencilAttachment) {
			JS(&j, ",\"depthStencilAttachment\":");
			j_attref(&j, s->pDepthStencilAttachment);
		}
		JS(&j, ",\"preserveAttachments\":");
		j_u32s(&j, s->pPreserveAttachments, s->preserveAttachmentCount);
		JS(&j, "}");
	}
	JS(&j, "],\"dependencies\":[");
	for (uint32_t i = 0; i < ci->dependencyCount; i++) {
		const VkSubpassDependency *x = &ci->pDependencies[i];
		jb_printf(&j, "%s{\"srcSubpass\":%u,\"dstSubpass\":%u,\"srcStageMask\":%u,\"dstStageMask\":%u,\"srcAccessMask\":%u,"
			      "\"dstAccessMask\":%u,\"dependencyFlags\":%u}",
			  i ? "," : "", x->srcSubpass, x->dstSubpass, x->srcStageMask, x->dstStageMask, x->srcAccessMask,
			  x->dstAccessMask, x->dependencyFlags);
	}
	JS(&j, "]}");
	send_msg(d, &j, NULL, 0);
	*out = (VkRenderPass)(uintptr_t)o;
	return VK_SUCCESS;
}
DESTROY_FN(RenderPass, VkRenderPass)

static API void CALL kw_vkGetRenderAreaGranularity(VkDevice d, VkRenderPass r, VkExtent2D *g)
{
	(void)d, (void)r;
	g->width = g->height = 1;
}

/*
 * Framebuffers. The host's framebuffer is its attachments' views and size.
 * An imageless one (imagelessFramebuffer: VK_FRAMEBUFFER_CREATE_IMAGELESS_BIT,
 * its views given at vkCmdBeginRenderPass) is a host framebuffer per set of
 * views it begins with, made when a command buffer first records that set
 * and destroyed with it.
 */
struct kw_fbset {
	struct kw_fbset *next;
	uint32_t id, n;
	uint32_t views[];
};
struct kw_fb {
	uint32_t id; /* 0 for an imageless one (first: OID reads it as a kw_obj) */
	uint32_t rp, width, height, layers;
	pthread_mutex_t mu;
	struct kw_fbset *sets;
};

static void j_framebuffer(struct jb *j, uint32_t id, uint32_t rp, const uint32_t *views, uint32_t n, uint32_t w, uint32_t h, uint32_t layers)
{
	jb_printf(j, "{\"op\":\"vkCreateFramebuffer\",\"id\":%u,\"renderPass\":%u,\"attachments\":[", id, rp);
	for (uint32_t i = 0; i < n; i++)
		jb_printf(j, i ? ",%u" : "%u", views[i]);
	jb_printf(j, "],\"width\":%u,\"height\":%u,\"layers\":%u}", w, h, layers);
}

static API VkResult CALL kw_vkCreateFramebuffer(VkDevice dh, const VkFramebufferCreateInfo *ci, const VkAllocationCallbacks *a, VkFramebuffer *out)
{
	(void)a;
	struct kw_device *d = DEV(dh);
	struct kw_fb *fb = calloc(1, sizeof *fb);
	fb->rp = oid((uint64_t)(uintptr_t)ci->renderPass);
	fb->width = ci->width, fb->height = ci->height, fb->layers = ci->layers;
	pthread_mutex_init(&fb->mu, NULL);
	if (!(ci->flags & VK_FRAMEBUFFER_CREATE_IMAGELESS_BIT)) {
		fb->id = link_id(d->link);
		uint32_t stack[16], *views = ci->attachmentCount <= 16 ? stack : malloc(ci->attachmentCount * sizeof *views);
		for (uint32_t i = 0; i < ci->attachmentCount; i++)
			views[i] = oid((uint64_t)(uintptr_t)ci->pAttachments[i]);
		struct jb j = {0};
		j_framebuffer(&j, fb->id, fb->rp, views, ci->attachmentCount, ci->width, ci->height, ci->layers);
		send_msg(d, &j, NULL, 0);
		if (views != stack)
			free(views);
	}
	*out = (VkFramebuffer)(uintptr_t)fb;
	return VK_SUCCESS;
}
static API void CALL kw_vkDestroyFramebuffer(VkDevice dh, VkFramebuffer h, const VkAllocationCallbacks *a)
{
	(void)a;
	struct kw_fb *fb = HANDLE(struct kw_fb, h);
	if (!fb)
		return;
	if (fb->id)
		destroy_id(DEV(dh), fb->id);
	for (struct kw_fbset *s = fb->sets, *next; s; s = next) {
		next = s->next;
		destroy_id(DEV(dh), s->id);
		free(s);
	}
	pthread_mutex_destroy(&fb->mu);
	free(fb);
}

/* the host framebuffer a render pass begins with: an imageless one's for
 * the views of its VkRenderPassAttachmentBeginInfo */
static uint32_t fb_begin(struct kw_device *d, const VkRenderPassBeginInfo *rp)
{
	struct kw_fb *fb = HANDLE(struct kw_fb, rp->framebuffer);
	if (!fb || fb->id)
		return fb ? fb->id : 0;
	const VkRenderPassAttachmentBeginInfo *ab = NULL;
	for (const VkBaseInStructure *s = rp->pNext; s; s = s->pNext)
		if (s->sType == VK_STRUCTURE_TYPE_RENDER_PASS_ATTACHMENT_BEGIN_INFO)
			ab = (const void *)s;
	uint32_t n = ab ? ab->attachmentCount : 0;
	uint32_t stack[16], *views = n <= 16 ? stack : malloc(n * sizeof *views);
	for (uint32_t i = 0; i < n; i++)
		views[i] = oid((uint64_t)(uintptr_t)ab->pAttachments[i]);
	pthread_mutex_lock(&fb->mu);
	struct kw_fbset *set = fb->sets;
	while (set && (set->n != n || memcmp(set->views, views, n * sizeof *views)))
		set = set->next;
	if (!set) {
		set = calloc(1, sizeof *set + n * sizeof *views);
		set->id = link_id(d->link);
		set->n = n;
		memcpy(set->views, views, n * sizeof *views);
		set->next = fb->sets;
		fb->sets = set;
		/* sent now: it reaches the host before any submit of this command buffer */
		struct jb j = {0};
		j_framebuffer(&j, set->id, fb->rp, views, n, fb->width, fb->height, fb->layers);
		send_msg(d, &j, NULL, 0);
	}
	uint32_t id = set->id;
	pthread_mutex_unlock(&fb->mu);
	if (views != stack)
		free(views);
	return id;
}

/* ---- pipelines ---- */

static void j_stage(struct jb *j, const VkPipelineShaderStageCreateInfo *s)
{
	jb_printf(j, "{\"flags\":%u,\"stage\":%u,\"module\":%u,\"name\":", s->flags, s->stage, oid((uint64_t)(uintptr_t)s->module));
	jb_str(j, s->pName);
	const VkSpecializationInfo *sp = s->pSpecializationInfo;
	if (sp) {
		JS(j, ",\"specializationInfo\":{\"mapEntries\":[");
		for (uint32_t i = 0; i < sp->mapEntryCount; i++)
			jb_printf(j, "%s{\"constantID\":%u,\"offset\":%u,\"size\":%zu}", i ? "," : "", sp->pMapEntries[i].constantID,
				  sp->pMapEntries[i].offset, sp->pMapEntries[i].size);
		JS(j, "],\"data\":");
		j_bytes(j, sp->pData, sp->dataSize);
		JS(j, "}");
	}
	JS(j, "}");
}

static void j_stencil(struct jb *j, const VkStencilOpState *s)
{
	jb_printf(j, "{\"failOp\":%u,\"passOp\":%u,\"depthFailOp\":%u,\"compareOp\":%u,\"compareMask\":%u,\"writeMask\":%u,\"reference\":%u}",
		  s->failOp, s->passOp, s->depthFailOp, s->compareOp, s->compareMask, s->writeMask, s->reference);
}

static void j_viewport(struct jb *j, const VkViewport *v)
{
	JS(j, "{\"x\":");
	jb_float(j, v->x);
	JS(j, ",\"y\":");
	jb_float(j, v->y);
	JS(j, ",\"width\":");
	jb_float(j, v->width);
	JS(j, ",\"height\":");
	jb_float(j, v->height);
	JS(j, ",\"minDepth\":");
	jb_float(j, v->minDepth);
	JS(j, ",\"maxDepth\":");
	jb_float(j, v->maxDepth);
	JS(j, "}");
}

static void j_graphics(struct jb *j, uint32_t id, const VkGraphicsPipelineCreateInfo *ci)
{
	jb_printf(j, "{\"op\":\"vkCreateGraphicsPipelines\",\"id\":%u,\"flags\":%u,\"stages\":[", id, ci->flags);
	for (uint32_t i = 0; i < ci->stageCount; i++) {
		if (i)
			JS(j, ",");
		j_stage(j, &ci->pStages[i]);
	}
	JS(j, "]");
	const VkPipelineVertexInputStateCreateInfo *vi = ci->pVertexInputState;
	if (vi) {
		JS(j, ",\"vertexInputState\":{\"vertexBindingDescriptions\":[");
		for (uint32_t i = 0; i < vi->vertexBindingDescriptionCount; i++) {
			const VkVertexInputBindingDescription *x = &vi->pVertexBindingDescriptions[i];
			jb_printf(j, "%s{\"binding\":%u,\"stride\":%u,\"inputRate\":%u}", i ? "," : "", x->binding, x->stride, x->inputRate);
		}
		JS(j, "],\"vertexAttributeDescriptions\":[");
		for (uint32_t i = 0; i < vi->vertexAttributeDescriptionCount; i++) {
			const VkVertexInputAttributeDescription *x = &vi->pVertexAttributeDescriptions[i];
			jb_printf(j, "%s{\"location\":%u,\"binding\":%u,\"format\":%u,\"offset\":%u}", i ? "," : "", x->location,
				  x->binding, x->format, x->offset);
		}
		JS(j, "]}");
	}
	if (ci->pInputAssemblyState)
		jb_printf(j, ",\"inputAssemblyState\":{\"topology\":%u,\"primitiveRestartEnable\":%u}",
			  ci->pInputAssemblyState->topology, ci->pInputAssemblyState->primitiveRestartEnable);
	const VkPipelineRasterizationStateCreateInfo *rs = ci->pRasterizationState;
	int discard = rs && rs->rasterizerDiscardEnable;
	const VkPipelineViewportStateCreateInfo *vp = ci->pViewportState;
	if (vp && !discard) {
		jb_printf(j, ",\"viewportState\":{\"viewportCount\":%u,\"scissorCount\":%u", vp->viewportCount, vp->scissorCount);
		if (vp->pViewports) {
			JS(j, ",\"viewports\":[");
			for (uint32_t i = 0; i < vp->viewportCount; i++) {
				if (i)
					JS(j, ",");
				j_viewport(j, &vp->pViewports[i]);
			}
			JS(j, "]");
		}
		if (vp->pScissors) {
			JS(j, ",\"scissors\":[");
			for (uint32_t i = 0; i < vp->scissorCount; i++) {
				if (i)
					JS(j, ",");
				j_rect(j, vp->pScissors[i]);
			}
			JS(j, "]");
		}
		JS(j, "}");
	}
	if (rs) {
		jb_printf(j, ",\"rasterizationState\":{\"depthClampEnable\":%u,\"rasterizerDiscardEnable\":%u,\"polygonMode\":%u,"
			     "\"cullMode\":%u,\"frontFace\":%u,\"depthBiasEnable\":%u,\"depthBiasConstantFactor\":",
			  rs->depthClampEnable, rs->rasterizerDiscardEnable, rs->polygonMode, rs->cullMode, rs->frontFace, rs->depthBiasEnable);
		jb_float(j, rs->depthBiasConstantFactor);
		JS(j, ",\"depthBiasClamp\":");
		jb_float(j, rs->depthBiasClamp);
		JS(j, ",\"depthBiasSlopeFactor\":");
		jb_float(j, rs->depthBiasSlopeFactor);
		JS(j, ",\"lineWidth\":");
		jb_float(j, rs->lineWidth);
		JS(j, "}");
	}
	const VkPipelineMultisampleStateCreateInfo *ms = ci->pMultisampleState;
	if (ms && !discard) {
		jb_printf(j, ",\"multisampleState\":{\"rasterizationSamples\":%u,\"sampleShadingEnable\":%u,\"minSampleShading\":",
			  ms->rasterizationSamples, ms->sampleShadingEnable);
		jb_float(j, ms->minSampleShading);
		if (ms->pSampleMask)
			jb_printf(j, ",\"sampleMask\":[%u]", ms->pSampleMask[0]);
		jb_printf(j, ",\"alphaToCoverageEnable\":%u,\"alphaToOneEnable\":%u}", ms->alphaToCoverageEnable, ms->alphaToOneEnable);
	}
	const VkPipelineDepthStencilStateCreateInfo *ds = ci->pDepthStencilState;
	if (ds && !discard) {
		jb_printf(j, ",\"depthStencilState\":{\"flags\":%u,\"depthTestEnable\":%u,\"depthWriteEnable\":%u,\"depthCompareOp\":%u,"
			     "\"depthBoundsTestEnable\":%u,\"stencilTestEnable\":%u,\"front\":",
			  ds->flags, ds->depthTestEnable, ds->depthWriteEnable, ds->depthCompareOp, ds->depthBoundsTestEnable, ds->stencilTestEnable);
		j_stencil(j, &ds->front);
		JS(j, ",\"back\":");
		j_stencil(j, &ds->back);
		JS(j, ",\"minDepthBounds\":");
		jb_float(j, ds->minDepthBounds);
		JS(j, ",\"maxDepthBounds\":");
		jb_float(j, ds->maxDepthBounds);
		JS(j, "}");
	}
	const VkPipelineColorBlendStateCreateInfo *cb = ci->pColorBlendState;
	if (cb && !discard) {
		jb_printf(j, ",\"colorBlendState\":{\"logicOpEnable\":%u,\"logicOp\":%u,\"attachments\":[", cb->logicOpEnable, cb->logicOp);
		for (uint32_t i = 0; i < cb->attachmentCount; i++) {
			const VkPipelineColorBlendAttachmentState *x = &cb->pAttachments[i];
			jb_printf(j, "%s{\"blendEnable\":%u,\"srcColorBlendFactor\":%u,\"dstColorBlendFactor\":%u,\"colorBlendOp\":%u,"
				     "\"srcAlphaBlendFactor\":%u,\"dstAlphaBlendFactor\":%u,\"alphaBlendOp\":%u,\"colorWriteMask\":%u}",
				  i ? "," : "", x->blendEnable, x->srcColorBlendFactor, x->dstColorBlendFactor, x->colorBlendOp,
				  x->srcAlphaBlendFactor, x->dstAlphaBlendFactor, x->alphaBlendOp, x->colorWriteMask);
		}
		JS(j, "],\"blendConstants\":");
		j_floats(j, cb->blendConstants, 4);
		JS(j, "}");
	}
	if (ci->pDynamicState) {
		JS(j, ",\"dynamicState\":{\"dynamicStates\":");
		j_u32s(j, (const uint32_t *)ci->pDynamicState->pDynamicStates, ci->pDynamicState->dynamicStateCount);
		JS(j, "}");
	}
	for (const VkBaseInStructure *n = ci->pNext; n && !ci->renderPass; n = n->pNext)
		if (n->sType == VK_STRUCTURE_TYPE_PIPELINE_RENDERING_CREATE_INFO) {
			const VkPipelineRenderingCreateInfo *r = (const void *)n;
			jb_printf(j, ",\"rendering\":{\"viewMask\":%u,\"colorAttachmentFormats\":", r->viewMask);
			j_u32s(j, (const uint32_t *)r->pColorAttachmentFormats, r->colorAttachmentCount);
			jb_printf(j, ",\"depthAttachmentFormat\":%u,\"stencilAttachmentFormat\":%u}", r->depthAttachmentFormat,
				  r->stencilAttachmentFormat);
		}
	jb_printf(j, ",\"layout\":%u,\"renderPass\":%u,\"subpass\":%u}", oid((uint64_t)(uintptr_t)ci->layout),
		  oid((uint64_t)(uintptr_t)ci->renderPass), ci->subpass);
}

static const char *vk_result_name(VkResult r)
{
	switch (r) {
	case VK_ERROR_INVALID_SHADER_NV: return "VK_ERROR_INVALID_SHADER_NV";
	case VK_ERROR_FEATURE_NOT_PRESENT: return "VK_ERROR_FEATURE_NOT_PRESENT";
	case VK_ERROR_FORMAT_NOT_SUPPORTED: return "VK_ERROR_FORMAT_NOT_SUPPORTED";
	case VK_ERROR_OUT_OF_DEVICE_MEMORY: return "VK_ERROR_OUT_OF_DEVICE_MEMORY";
	case VK_ERROR_DEVICE_LOST: return "VK_ERROR_DEVICE_LOST";
	default: return "error";
	}
}

/*
 * Pipelines are requests with a reply: the host answers once it knows the
 * pipeline compiles (translation, WGSL compilation, WebGPU's pipeline
 * validation), with "err" (and maybe "result", a VkResult) when it cannot
 * be made, or "unusable" when it is made but cannot run (it declares a
 * resource kind WebGPU lacks: binding it in a submitted command buffer then
 * loses the device). All of a call's pipelines are sent before the first
 * wait, so they compile together. Failed ones are VK_NULL_HANDLE.
 */
static VkResult pipes_wait(struct kw_device *d, const char *call, uint32_t n, struct kw_pipe **ps, const uint32_t *rs, VkPipeline *out)
{
	VkResult res = VK_SUCCESS;
	for (uint32_t i = 0; i < n; i++) {
		struct kw_pipe *o = ps[i];
		struct kw_reply *rep = link_wait(d->link, rs[i]);
		VkResult r = VK_SUCCESS;
		const char *e = rep ? js_get(rep->json, "err") : NULL, *u = rep ? js_get(rep->json, "unusable") : NULL;
		char why[768];
		if (!rep) {
			r = VK_ERROR_DEVICE_LOST;
		} else if (e) {
			js_strcpy(e, why, sizeof why);
			r = (VkResult)js_num(js_get(rep->json, "result"), VK_ERROR_INVALID_SHADER_NV);
			if (r >= 0)
				r = VK_ERROR_INVALID_SHADER_NV;
			kw_err("%s: pipeline (id %u) not created: %s: %s", call, o->id, why, vk_result_name(r));
		} else if (u) {
			js_strcpy(u, why, sizeof why);
			o->bad = strdup(why);
			kw_err("%s: pipeline (id %u) cannot run on WebGPU (%s): created, but submitting a command buffer that binds it loses the device",
			       call, o->id, why);
		}
		reply_free(rep);
		if (r != VK_SUCCESS) {
			destroy_id(d, o->id);
			free(o);
			out[i] = VK_NULL_HANDLE;
			if (res == VK_SUCCESS)
				res = r;
		} else {
			out[i] = (VkPipeline)(uintptr_t)o;
		}
	}
	return res;
}

static API VkResult CALL kw_vkCreateGraphicsPipelines(VkDevice dh, VkPipelineCache c, uint32_t n, const VkGraphicsPipelineCreateInfo *ci,
	const VkAllocationCallbacks *a, VkPipeline *out)
{
	(void)c, (void)a;
	struct kw_device *d = DEV(dh);
	struct kw_pipe **ps = calloc(n ? n : 1, sizeof *ps);
	uint32_t *rs = calloc(n ? n : 1, sizeof *rs);
	for (uint32_t i = 0; i < n; i++) {
		ps[i] = new_pipe(d, ci[i].pStages, ci[i].stageCount);
		struct jb j = {0};
		j_graphics(&j, ps[i]->id, &ci[i]);
		rs[i] = link_send(d->link, &j, NULL, 0, 1);
		jb_free(&j);
	}
	VkResult res = pipes_wait(d, "vkCreateGraphicsPipelines", n, ps, rs, out);
	free(ps);
	free(rs);
	return res;
}

static API VkResult CALL kw_vkCreateComputePipelines(VkDevice dh, VkPipelineCache c, uint32_t n, const VkComputePipelineCreateInfo *ci,
	const VkAllocationCallbacks *a, VkPipeline *out)
{
	(void)c, (void)a;
	struct kw_device *d = DEV(dh);
	struct kw_pipe **ps = calloc(n ? n : 1, sizeof *ps);
	uint32_t *rs = calloc(n ? n : 1, sizeof *rs);
	for (uint32_t i = 0; i < n; i++) {
		ps[i] = new_pipe(d, &ci[i].stage, 1);
		struct jb j = {0};
		jb_printf(&j, "{\"op\":\"vkCreateComputePipelines\",\"id\":%u,\"flags\":%u,\"stage\":", ps[i]->id, ci[i].flags);
		j_stage(&j, &ci[i].stage);
		jb_printf(&j, ",\"layout\":%u}", oid((uint64_t)(uintptr_t)ci[i].layout));
		rs[i] = link_send(d->link, &j, NULL, 0, 1);
		jb_free(&j);
	}
	VkResult res = pipes_wait(d, "vkCreateComputePipelines", n, ps, rs, out);
	free(ps);
	free(rs);
	return res;
}

static API void CALL kw_vkDestroyPipeline(VkDevice dh, VkPipeline ph, const VkAllocationCallbacks *a)
{
	(void)a;
	struct kw_pipe *p = HANDLE(struct kw_pipe, ph);
	if (!p)
		return;
	destroy_id(DEV(dh), p->id);
	free(p->bad);
	free(p);
}

/* pipeline cache: guest-only, empty */
static API VkResult CALL kw_vkCreatePipelineCache(VkDevice d, const VkPipelineCacheCreateInfo *ci, const VkAllocationCallbacks *a, VkPipelineCache *out)
{
	(void)d, (void)ci, (void)a;
	*out = (VkPipelineCache)(uintptr_t)calloc(1, 8);
	return VK_SUCCESS;
}
static API void CALL kw_vkDestroyPipelineCache(VkDevice d, VkPipelineCache c, const VkAllocationCallbacks *a)
{
	(void)d, (void)a;
	free(HANDLE(void, c));
}
static API VkResult CALL kw_vkGetPipelineCacheData(VkDevice d, VkPipelineCache c, size_t *n, void *p)
{
	(void)d, (void)c, (void)p;
	*n = 0;
	return VK_SUCCESS;
}
static API VkResult CALL kw_vkMergePipelineCaches(VkDevice d, VkPipelineCache c, uint32_t n, const VkPipelineCache *s)
{
	(void)d, (void)c, (void)n, (void)s;
	return VK_SUCCESS;
}

/* ---- descriptors ---- */

static API VkResult CALL kw_vkCreateDescriptorPool(VkDevice d, const VkDescriptorPoolCreateInfo *ci, const VkAllocationCallbacks *a, VkDescriptorPool *out)
{
	(void)d, (void)ci, (void)a;
	*out = (VkDescriptorPool)(uintptr_t)calloc(1, sizeof(struct kw_dpool));
	return VK_SUCCESS;
}

static void free_sets(struct kw_device *d, struct kw_dpool *p, struct kw_dset *only)
{
	uint32_t ids[256];
	size_t n = 0;
	struct kw_dset *s = only ? only : p->sets;
	while (s) {
		struct kw_dset *next = only ? NULL : s->next;
		if (s->prev)
			s->prev->next = s->next;
		else
			p->sets = s->next;
		if (s->next)
			s->next->prev = s->prev;
		ids[n++] = s->id;
		if (n == 256) {
			destroy_ids(d->link, ids, n);
			n = 0;
		}
		dsl_unref(s->layout);
		free(s->slots);
		free(s);
		s = next;
	}
	destroy_ids(d->link, ids, n);
}

static API void CALL kw_vkDestroyDescriptorPool(VkDevice dh, VkDescriptorPool ph, const VkAllocationCallbacks *a)
{
	(void)a;
	struct kw_dpool *p = HANDLE(struct kw_dpool, ph);
	if (!p)
		return;
	free_sets(DEV(dh), p, NULL);
	free(p);
}

static API VkResult CALL kw_vkResetDescriptorPool(VkDevice dh, VkDescriptorPool ph, VkDescriptorPoolResetFlags f)
{
	(void)f;
	free_sets(DEV(dh), HANDLE(struct kw_dpool, ph), NULL);
	return VK_SUCCESS;
}

static API VkResult CALL kw_vkAllocateDescriptorSets(VkDevice dh, const VkDescriptorSetAllocateInfo *ai, VkDescriptorSet *out)
{
	struct kw_device *d = DEV(dh);
	struct kw_dpool *p = HANDLE(struct kw_dpool, ai->descriptorPool);
	struct jb j = {0};
	JS(&j, "{\"op\":\"vkAllocateDescriptorSets\",\"sets\":[");
	for (uint32_t i = 0; i < ai->descriptorSetCount; i++) {
		struct kw_dset *s = calloc(1, sizeof *s);
		s->id = link_id(d->link);
		s->pool = p;
		s->layout = HANDLE(struct kw_dsl, ai->pSetLayouts[i]);
		if (s->layout)
			__atomic_add_fetch(&s->layout->refs, 1, __ATOMIC_ACQ_REL);
		s->next = p->sets;
		if (p->sets)
			p->sets->prev = s;
		p->sets = s;
		jb_printf(&j, "%s{\"id\":%u,\"layout\":%u}", i ? "," : "", s->id, oid((uint64_t)(uintptr_t)ai->pSetLayouts[i]));
		out[i] = (VkDescriptorSet)(uintptr_t)s;
	}
	JS(&j, "]}");
	send_msg(d, &j, NULL, 0);
	return VK_SUCCESS;
}

static API VkResult CALL kw_vkFreeDescriptorSets(VkDevice dh, VkDescriptorPool ph, uint32_t n, const VkDescriptorSet *sets)
{
	struct kw_dpool *p = HANDLE(struct kw_dpool, ph);
	for (uint32_t i = 0; i < n; i++)
		if (sets[i])
			free_sets(DEV(dh), p, HANDLE(struct kw_dset, sets[i]));
	return VK_SUCCESS;
}

/*
 * A position in a set for Vulkan's consecutive binding updates: a write or
 * copy of N descriptors from (binding, element) goes on, past a binding's
 * last element, at element 0 of the next binding by number that has
 * descriptors (zero-count bindings are skipped). The host numbers them the
 * same way (vk-host.ts, vkUpdateDescriptorSets), a binding the layout lacks
 * counting as one descriptor.
 */
struct dpos {
	uint32_t binding, elem;
	int i; /* index in the layout's bindings, -1: not in it */
};
static void dpos_init(const struct kw_dsl *l, struct dpos *p, uint32_t binding, uint32_t elem)
{
	p->binding = binding;
	p->elem = elem;
	p->i = -1;
	for (uint32_t k = 0; l && k < l->n; k++)
		if (l->b[k].binding == binding)
			p->i = (int)k;
}
/* settles p on a descriptor; 0 past the last binding */
static int dpos_settle(const struct kw_dsl *l, struct dpos *p)
{
	if (!l)
		return 1;
	while (p->elem >= (p->i >= 0 ? l->b[p->i].count : 1)) {
		int next = -1;
		for (uint32_t k = 0; k < l->n && next < 0; k++)
			if (l->b[k].binding > p->binding)
				next = (int)k;
		if (next < 0)
			return 0;
		p->i = next;
		p->binding = l->b[next].binding;
		p->elem = 0;
	}
	return 1;
}
/* the index of p's dynamic offset among the set's, -1 when not dynamic */
static int dpos_dyn(const struct kw_dsl *l, const struct dpos *p)
{
	if (!l || p->i < 0)
		return -1;
	const struct kw_dsl_binding *b = &l->b[p->i];
	if (b->type != VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER_DYNAMIC && b->type != VK_DESCRIPTOR_TYPE_STORAGE_BUFFER_DYNAMIC)
		return -1;
	return (int)(b->dyn + p->elem);
}

static void set_slot(struct kw_dset *s, const struct kw_dslot *v)
{
	for (size_t i = 0; i < s->nslots; i++)
		if (s->slots[i].binding == v->binding && s->slots[i].elem == v->elem) {
			s->slots[i] = *v;
			return;
		}
	s->slots = realloc(s->slots, (s->nslots + 1) * sizeof *s->slots);
	s->slots[s->nslots++] = *v;
}

static API void CALL kw_vkUpdateDescriptorSets(VkDevice dh, uint32_t nw, const VkWriteDescriptorSet *w, uint32_t nc, const VkCopyDescriptorSet *c)
{
	struct kw_device *d = DEV(dh);
	struct jb j = {0};
	JS(&j, "{\"op\":\"vkUpdateDescriptorSets\",\"descriptorWrites\":[");
	for (uint32_t i = 0; i < nw; i++) {
		const VkWriteDescriptorSet *x = &w[i];
		struct kw_dset *s = HANDLE(struct kw_dset, x->dstSet);
		jb_printf(&j, "%s{\"dstSet\":%u,\"dstBinding\":%u,\"dstArrayElement\":%u,\"descriptorType\":%u", i ? "," : "",
			  s->id, x->dstBinding, x->dstArrayElement, x->descriptorType);
		switch (x->descriptorType) {
		case VK_DESCRIPTOR_TYPE_SAMPLER:
		case VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER:
		case VK_DESCRIPTOR_TYPE_SAMPLED_IMAGE:
		case VK_DESCRIPTOR_TYPE_STORAGE_IMAGE:
		case VK_DESCRIPTOR_TYPE_INPUT_ATTACHMENT:
			JS(&j, ",\"imageInfo\":[");
			for (uint32_t k = 0; k < x->descriptorCount; k++) {
				const VkDescriptorImageInfo *ii = &x->pImageInfo[k];
				uint32_t smp = x->descriptorType == VK_DESCRIPTOR_TYPE_SAMPLER ||
						       x->descriptorType == VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER
					       ? oid((uint64_t)(uintptr_t)ii->sampler)
					       : 0;
				uint32_t view = x->descriptorType == VK_DESCRIPTOR_TYPE_SAMPLER ? 0 : oid((uint64_t)(uintptr_t)ii->imageView);
				jb_printf(&j, "%s{\"sampler\":%u,\"imageView\":%u,\"imageLayout\":%u}", k ? "," : "", smp, view, ii->imageLayout);
			}
			JS(&j, "]");
			break;
		case VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER:
		case VK_DESCRIPTOR_TYPE_STORAGE_BUFFER:
		case VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER_DYNAMIC:
		case VK_DESCRIPTOR_TYPE_STORAGE_BUFFER_DYNAMIC: {
			JS(&j, ",\"bufferInfo\":[");
			/* buffers are tracked where they really land (consecutive binding updates) */
			int storage = x->descriptorType == VK_DESCRIPTOR_TYPE_STORAGE_BUFFER ||
				      x->descriptorType == VK_DESCRIPTOR_TYPE_STORAGE_BUFFER_DYNAMIC;
			struct dpos at;
			dpos_init(s->layout, &at, x->dstBinding, x->dstArrayElement);
			for (uint32_t k = 0; k < x->descriptorCount; k++) {
				const VkDescriptorBufferInfo *bi = &x->pBufferInfo[k];
				struct kw_buffer *b = HANDLE(struct kw_buffer, bi->buffer);
				jb_printf(&j, "%s{\"buffer\":%u,\"offset\":%llu,\"range\":", k ? "," : "", b ? b->id : 0,
					  (unsigned long long)bi->offset);
				j_size(&j, bi->range);
				JS(&j, "}");
				if (dpos_settle(s->layout, &at)) {
					set_slot(s, &(struct kw_dslot){at.binding, at.elem, b, bi->offset, bi->range, dpos_dyn(s->layout, &at), storage});
					at.elem++;
				}
			}
			JS(&j, "]");
			break;
		}
		case VK_DESCRIPTOR_TYPE_UNIFORM_TEXEL_BUFFER:
		case VK_DESCRIPTOR_TYPE_STORAGE_TEXEL_BUFFER: {
			/* tracked as the view's range of its buffer, as buffers are
			 * (consecutive binding updates); a storage one may be written */
			JS(&j, ",\"texelBufferView\":[");
			struct dpos at;
			dpos_init(s->layout, &at, x->dstBinding, x->dstArrayElement);
			for (uint32_t k = 0; k < x->descriptorCount; k++) {
				struct kw_bview *v = HANDLE(struct kw_bview, x->pTexelBufferView[k]);
				jb_printf(&j, k ? ",%u" : "%u", v ? v->id : 0);
				if (dpos_settle(s->layout, &at)) {
					set_slot(s, &(struct kw_dslot){at.binding, at.elem, v ? v->buf : NULL, v ? v->offset : 0, v ? v->range : 0, -1,
							       x->descriptorType == VK_DESCRIPTOR_TYPE_STORAGE_TEXEL_BUFFER});
					at.elem++;
				}
			}
			JS(&j, "]");
			break;
		}
		default:
			kw_log("descriptor type %u is unsupported", x->descriptorType);
		}
		JS(&j, "}");
	}
	JS(&j, "],\"descriptorCopies\":[");
	for (uint32_t i = 0; i < nc; i++) {
		const VkCopyDescriptorSet *x = &c[i];
		struct kw_dset *src = HANDLE(struct kw_dset, x->srcSet), *dst = HANDLE(struct kw_dset, x->dstSet);
		jb_printf(&j, "%s{\"srcSet\":%u,\"srcBinding\":%u,\"srcArrayElement\":%u,\"dstSet\":%u,\"dstBinding\":%u,"
			      "\"dstArrayElement\":%u,\"descriptorCount\":%u}",
			  i ? "," : "", src->id, x->srcBinding, x->srcArrayElement, dst->id, x->dstBinding, x->dstArrayElement,
			  x->descriptorCount);
		/* both sides follow the consecutive binding updates */
		struct dpos sp, dp;
		dpos_init(src->layout, &sp, x->srcBinding, x->srcArrayElement);
		dpos_init(dst->layout, &dp, x->dstBinding, x->dstArrayElement);
		for (uint32_t k = 0; k < x->descriptorCount; k++) {
			if (!dpos_settle(src->layout, &sp) || !dpos_settle(dst->layout, &dp))
				break;
			for (size_t q = 0; q < src->nslots; q++)
				if (src->slots[q].binding == sp.binding && src->slots[q].elem == sp.elem) {
					struct kw_dslot v = src->slots[q];
					v.binding = dp.binding;
					v.elem = dp.elem;
					v.dyn = dpos_dyn(dst->layout, &dp);
					set_slot(dst, &v);
					break;
				}
			sp.elem++;
			dp.elem++;
		}
	}
	JS(&j, "]}");
	send_msg(d, &j, NULL, 0);
}

/* ---- sync objects (guest-only) ---- */

static API VkResult CALL kw_vkCreateFence(VkDevice d, const VkFenceCreateInfo *ci, const VkAllocationCallbacks *a, VkFence *out)
{
	(void)d, (void)a;
	struct kw_fence *f = calloc(1, sizeof *f);
	f->signaled = (ci->flags & VK_FENCE_CREATE_SIGNALED_BIT) != 0;
	*out = (VkFence)(uintptr_t)f;
	return VK_SUCCESS;
}

static int fence_wait_slice(struct kw_device *d, struct kw_fence *f, int64_t slice_ns);
static void tl_reached(struct kw_device *d, uint64_t seq);
static void held_forget(struct kw_device *d, const void *obj);
static void cv_wait_ns(pthread_cond_t *cv, pthread_mutex_t *mu, int64_t ns);

/* waits for f's pending submit (if any) and marks it signaled */
static void fence_complete(struct kw_device *d, struct kw_fence *f)
{
	while (f->r && !f->signaled && !fence_wait_slice(d, f, 20000000))
		;
	f->r = 0;
	f->signaled = 1;
}

static API void CALL kw_vkDestroyFence(VkDevice dh, VkFence fh, const VkAllocationCallbacks *a)
{
	(void)a;
	struct kw_fence *f = HANDLE(struct kw_fence, fh);
	if (!f)
		return;
	if (f->r)
		fence_complete(DEV(dh), f);
	if (__atomic_load_n(&f->held, __ATOMIC_ACQUIRE))
		held_forget(DEV(dh), f); /* not valid usage, but no dangling pointer */
	free(f);
}

static API VkResult CALL kw_vkResetFences(VkDevice dh, uint32_t n, const VkFence *fs)
{
	for (uint32_t i = 0; i < n; i++) {
		struct kw_fence *f = HANDLE(struct kw_fence, fs[i]);
		if (f->r)
			fence_complete(DEV(dh), f);
		f->signaled = 0;
	}
	return VK_SUCCESS;
}

static API VkResult CALL kw_vkGetFenceStatus(VkDevice dh, VkFence fh)
{
	struct kw_device *d = DEV(dh);
	struct kw_fence *f = HANDLE(struct kw_fence, fh);
	if (d->link->dead)
		return VK_ERROR_DEVICE_LOST;
	if (f->signaled) {
		/* signaled at submit: GPU writes to mapped memory come back now */
		inflight_reap(d, KW_INFLIGHT);
		kw_readback(d, NULL);
		return d->link->dead ? VK_ERROR_DEVICE_LOST : VK_SUCCESS;
	}
	/* A caller that spins on the status (ggml-vulkan does, at the end of
	 * each graph) would keep the guest's CPU busy while the host works, and
	 * an inline-mode host runs only when the guest's kernel idles or yields
	 * (every 20 ms): from the second poll of the same submit on, wait up to
	 * 1 ms for the reply in the kernel instead (it ends at the reply). */
	uint32_t r = f->r;
	if (r && ((link_poll(d->link, r) && fence_wait_slice(d, f, 0)) ||
		  (__atomic_add_fetch(&f->polls, 1, __ATOMIC_RELAXED) > 1 && fence_wait_slice(d, f, 1000000)))) {
		kw_readback(d, NULL);
		return d->link->dead ? VK_ERROR_DEVICE_LOST : VK_SUCCESS;
	}
	return d->link->dead ? VK_ERROR_DEVICE_LOST : VK_NOT_READY;
}

static int64_t mono_ns(void)
{
	struct timespec t;
	clock_gettime(CLOCK_MONOTONIC, &t);
	return (int64_t)t.tv_sec * 1000000000 + t.tv_nsec;
}

/* waits up to slice_ns for f's submit reply; 1 when f is signaled. Several
 * threads may wait on one fence: each waits in slices and rechecks. */
static int fence_wait_slice(struct kw_device *d, struct kw_fence *f, int64_t slice_ns)
{
	uint32_t r = __atomic_load_n(&f->r, __ATOMIC_ACQUIRE);
	if (__atomic_load_n(&f->signaled, __ATOMIC_ACQUIRE))
		return 1;
	if (!r)
		return 0;
	int to = 0;
	struct kw_reply *rep = link_wait_timeout(d->link, r, slice_ns, &to);
	if (rep || !to) { /* the reply, or a dead link */
		/* an "err" reply: the submit did not run (the host has also ended
		 * the link): the device is lost, the fence counts as signaled so no
		 * waiter hangs, and every wait reports VK_ERROR_DEVICE_LOST */
		uint64_t seq = f->seq;
		if (rep && !kw_reply_lost(d->link, rep, "vkQueueSubmit"))
			tl_reached(d, seq); /* timeline values of its submit and earlier ones */
		reply_free(rep);
		uint32_t exp = r;
		__atomic_compare_exchange_n(&f->r, &exp, 0, 0, __ATOMIC_ACQ_REL, __ATOMIC_ACQUIRE);
		__atomic_store_n(&f->signaled, 1, __ATOMIC_RELEASE);
		return 1;
	}
	return __atomic_load_n(&f->signaled, __ATOMIC_ACQUIRE);
}

static API VkResult CALL kw_vkWaitForFences(VkDevice dh, uint32_t n, const VkFence *fs, VkBool32 all, uint64_t timeout)
{
	struct kw_device *d = DEV(dh);
	int64_t t0 = kw_now();
	int64_t end = timeout >= (uint64_t)INT64_MAX / 2 ? INT64_MAX : mono_ns() + (int64_t)timeout;
	int waited = 0;
	VkResult res = VK_TIMEOUT;
	for (;;) {
		uint32_t ready = 0, pending = 0, held = 0;
		for (uint32_t i = 0; i < n; i++) {
			struct kw_fence *f = HANDLE(struct kw_fence, fs[i]);
			if (f->signaled || (f->r && link_poll(d->link, f->r) && fence_wait_slice(d, f, 0)))
				ready++;
			else if (f->r)
				pending++;
			else if (__atomic_load_n(&f->held, __ATOMIC_ACQUIRE))
				held++;
		}
		if (all ? ready == n : ready > 0) {
			res = VK_SUCCESS;
			break;
		}
		if (d->link->dead) {
			res = VK_ERROR_DEVICE_LOST;
			break;
		}
		int64_t left = end - mono_ns();
		if (left <= 0)
			break;
		if (!pending && held) {
			/* submits held in the ICD until a timeline value is signalled
			 * (another thread's vkSignalSemaphore): wait for a release */
			pthread_mutex_lock(&d->q_mu);
			int still = 0;
			for (uint32_t i = 0; i < n; i++)
				still |= HANDLE(struct kw_fence, fs[i])->held;
			if (still)
				cv_wait_ns(&d->q_cv, &d->q_mu, left < 20000000 ? left : 20000000);
			pthread_mutex_unlock(&d->q_mu);
			link_poll(d->link, 0); /* a lost device's last frame, when it has come */
			continue;
		}
		if (!pending) { /* never submitted: only a timeout ends this */
			if (end == INT64_MAX) {
				kw_log("waiting forever on fences that were never submitted");
				break;
			}
			struct timespec ts = {left / 1000000000, left % 1000000000};
			nanosleep(&ts, NULL);
			break;
		}
		/* wait on the first pending fence for a while */
		int64_t slice = left < 20000000 ? left : 20000000;
		for (uint32_t i = 0; i < n; i++) {
			struct kw_fence *f = HANDLE(struct kw_fence, fs[i]);
			if (!f->signaled && f->r) {
				waited |= fence_wait_slice(d, f, slice);
				break;
			}
		}
	}
	inflight_reap(d, KW_INFLIGHT); /* replies that have come: a failed submit is a lost device */
	kw_stats.wait_ns += kw_now() - t0;
	if ((waited || res == VK_SUCCESS) && !d->link->dead)
		kw_readback(d, NULL);
	return d->link->dead ? VK_ERROR_DEVICE_LOST : res;
}

/*
 * Semaphores. The one queue runs in submission order, so binary semaphores
 * between submits need nothing. Timeline semaphores keep their values
 * guest-side (vk/PROTOCOL.md, Amendments, "Timeline semaphores"):
 *   - `submitted` is the highest value that sent work or vkSignalSemaphore
 *     gives. A queue wait for a value above it holds that submit in the
 *     ICD, with every later one, until a vkSignalSemaphore or the release
 *     of an earlier held submit gives it (held_pump);
 *   - `value` is the value reached. As for fences ("Fences at submit"), a
 *     value that a submit writing no host-visible memory signals is reached
 *     at the submit. One that a submit which may write host-visible memory
 *     signals is reached at its reply: a sync request sent after it, kept
 *     in kw_device.tl. A fence wait or wait-idle covering it, or a later
 *     submit's values being reached, reaches it too (queue order). Waits
 *     and counter queries read back what submitted work wrote to mapped
 *     memory, as fence waits do, and report a lost device.
 * sem_mu guards the values and every device's tl list; sem_cv is signalled
 * when a value rises.
 */
struct kw_sem {
	int timeline;
	uint64_t value; /* reached */
	uint64_t submitted; /* given by sent work or the host (value <= submitted) */
};
struct kw_tlsig {
	struct kw_sem *sem; /* NULL: destroyed since */
	uint64_t value;
};
struct kw_tlpend {
	struct kw_tlpend *next;
	uint64_t seq; /* the submit's place in the queue (kw_device.seq) */
	uint32_t r; /* the sync request sent after it; 0 once its reply was taken */
	int reached; /* the values were applied */
	int claimed; /* a thread waits for r */
	uint32_t n;
	struct kw_tlsig sig[];
};
static pthread_mutex_t sem_mu = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t sem_cv = PTHREAD_COND_INITIALIZER;

/* pthread_cond_timedwait for up to ns from now */
static void cv_wait_ns(pthread_cond_t *cv, pthread_mutex_t *mu, int64_t ns)
{
	struct timespec ts;
	clock_gettime(CLOCK_REALTIME, &ts);
	int64_t t = (int64_t)ts.tv_sec * 1000000000 + ts.tv_nsec + (ns > 0 ? ns : 0);
	ts.tv_sec = t / 1000000000;
	ts.tv_nsec = t % 1000000000;
	pthread_cond_timedwait(cv, mu, &ts);
}

static void sem_raise(struct kw_sem *sem, uint64_t v)
{
	if (sem && v > sem->value)
		sem->value = v;
}

/* sem_mu held: every submit up to `seq` is done, so the values of the tl
 * entries up to it are reached (in queue order); entries whose reply was
 * taken as well are dropped */
static void tl_reach_locked(struct kw_device *d, uint64_t seq)
{
	int any = 0;
	for (struct kw_tlpend **pp = &d->tl, *e; (e = *pp) && e->seq <= seq;) {
		if (!e->reached) {
			for (uint32_t k = 0; k < e->n; k++)
				sem_raise(e->sig[k].sem, e->sig[k].value);
			e->reached = any = 1;
		}
		if (!e->r && !e->claimed) {
			*pp = e->next;
			free(e);
		} else {
			pp = &e->next;
		}
	}
	if (any)
		pthread_cond_broadcast(&sem_cv);
}

/* Takes the reply to the oldest tl entry not yet answered: one that has
 * come (timeout_ns 0), or waiting up to timeout_ns for it. 1 when it took
 * one. A reply with "err" loses the device. */
static int tl_take(struct kw_device *d, int64_t timeout_ns)
{
	pthread_mutex_lock(&sem_mu);
	struct kw_tlpend *e = d->tl;
	while (e && !e->r)
		e = e->next;
	if (!e || d->link->dead) {
		if (!e && !d->link->dead && timeout_ns > 0) /* nothing due: a value can only rise by another thread */
			cv_wait_ns(&sem_cv, &sem_mu, timeout_ns);
		pthread_mutex_unlock(&sem_mu);
		return 0;
	}
	if (e->claimed) { /* another thread waits for it: wait for that thread */
		if (timeout_ns > 0)
			cv_wait_ns(&sem_cv, &sem_mu, timeout_ns);
		pthread_mutex_unlock(&sem_mu);
		return 0;
	}
	e->claimed = 1;
	uint32_t r = e->r;
	pthread_mutex_unlock(&sem_mu);
	struct kw_reply *rep = NULL;
	int got;
	if (timeout_ns > 0) {
		int to = 0;
		rep = link_wait_timeout(d->link, r, timeout_ns, &to);
		got = rep || !to; /* the reply, or a dead link */
	} else if ((got = link_poll(d->link, r))) {
		rep = link_wait(d->link, r);
	}
	int lost = got && kw_reply_lost(d->link, rep, "vkQueueSubmit");
	reply_free(rep);
	pthread_mutex_lock(&sem_mu);
	e->claimed = 0;
	if (got) {
		e->r = 0;
		if (!lost)
			tl_reach_locked(d, e->seq);
	}
	pthread_cond_broadcast(&sem_cv);
	pthread_mutex_unlock(&sem_mu);
	return got && !lost;
}

/* the replies of timeline signals that have come */
static void tl_poll(struct kw_device *d)
{
	while (d->tl && tl_take(d, 0))
		;
}

/* at vkDestroyDevice: every reply still due taken, the list freed */
static void tl_drop(struct kw_device *d)
{
	pthread_mutex_lock(&sem_mu);
	struct kw_tlpend *e = d->tl;
	d->tl = NULL;
	pthread_mutex_unlock(&sem_mu);
	while (e) {
		struct kw_tlpend *next = e->next;
		if (e->r && !d->link->dead)
			reply_free(link_wait(d->link, e->r));
		free(e);
		e = next;
	}
}

static API VkResult CALL kw_vkCreateSemaphore(VkDevice d, const VkSemaphoreCreateInfo *ci, const VkAllocationCallbacks *a, VkSemaphore *out)
{
	(void)d, (void)a;
	struct kw_sem *sem = calloc(1, sizeof *sem);
	for (const VkBaseInStructure *s = ci->pNext; s; s = s->pNext)
		if (s->sType == VK_STRUCTURE_TYPE_SEMAPHORE_TYPE_CREATE_INFO &&
		    ((const VkSemaphoreTypeCreateInfo *)s)->semaphoreType == VK_SEMAPHORE_TYPE_TIMELINE) {
			sem->timeline = 1;
			sem->value = sem->submitted = ((const VkSemaphoreTypeCreateInfo *)s)->initialValue;
		}
	*out = (VkSemaphore)(uintptr_t)sem;
	return VK_SUCCESS;
}

static void held_forget(struct kw_device *d, const void *obj);

static API void CALL kw_vkDestroySemaphore(VkDevice dh, VkSemaphore s, const VkAllocationCallbacks *a)
{
	(void)a;
	struct kw_sem *sem = HANDLE(struct kw_sem, s);
	struct kw_device *d = DEV(dh);
	if (!sem)
		return;
	if (sem->timeline && d) {
		/* the app waited for the work that signals it, but replies may
		 * not have been taken: forget it there */
		held_forget(d, sem);
		pthread_mutex_lock(&sem_mu);
		for (struct kw_tlpend *e = d->tl; e; e = e->next)
			for (uint32_t k = 0; k < e->n; k++)
				if (e->sig[k].sem == sem)
					e->sig[k].sem = NULL;
		pthread_mutex_unlock(&sem_mu);
	}
	free(sem);
}

static API VkResult CALL kw_vkCreateEvent(VkDevice d, const VkEventCreateInfo *ci, const VkAllocationCallbacks *a, VkEvent *out)
{
	(void)d, (void)ci, (void)a;
	*out = (VkEvent)(uintptr_t)calloc(1, sizeof(int));
	return VK_SUCCESS;
}
static API void CALL kw_vkDestroyEvent(VkDevice d, VkEvent e, const VkAllocationCallbacks *a)
{
	(void)d, (void)a;
	free(HANDLE(void, e));
}
static API VkResult CALL kw_vkGetEventStatus(VkDevice d, VkEvent e)
{
	(void)d;
	return *HANDLE(int, e) ? VK_EVENT_SET : VK_EVENT_RESET;
}
static API VkResult CALL kw_vkSetEvent(VkDevice d, VkEvent e)
{
	(void)d;
	*HANDLE(int, e) = 1;
	return VK_SUCCESS;
}
static API VkResult CALL kw_vkResetEvent(VkDevice d, VkEvent e)
{
	(void)d;
	*HANDLE(int, e) = 0;
	return VK_SUCCESS;
}

/* queries: host-side query sets (occlusion, timestamp; statistics read 0) */
struct kw_qpool {
	uint32_t id;
	VkQueryType type;
	uint32_t count;
	VkQueryPipelineStatisticFlags stats;
};

static API VkResult CALL kw_vkCreateQueryPool(VkDevice dh, const VkQueryPoolCreateInfo *ci, const VkAllocationCallbacks *a, VkQueryPool *out)
{
	(void)a;
	struct kw_device *d = DEV(dh);
	struct kw_qpool *q = calloc(1, sizeof *q);
	q->id = link_id(d->link);
	q->type = ci->queryType;
	q->count = ci->queryCount;
	q->stats = ci->pipelineStatistics;
	struct jb j = {0};
	jb_printf(&j, "{\"op\":\"vkCreateQueryPool\",\"id\":%u,\"flags\":%u,\"queryType\":%u,\"queryCount\":%u,\"pipelineStatistics\":%u}",
		  q->id, ci->flags, ci->queryType, ci->queryCount, ci->pipelineStatistics);
	send_msg(d, &j, NULL, 0);
	*out = (VkQueryPool)(uintptr_t)q;
	return VK_SUCCESS;
}
static API void CALL kw_vkDestroyQueryPool(VkDevice d, VkQueryPool qh, const VkAllocationCallbacks *a)
{
	(void)a;
	struct kw_qpool *q = HANDLE(struct kw_qpool, qh);
	if (!q)
		return;
	destroy_id(DEV(d), q->id);
	free(q);
}
static API void CALL kw_vkResetQueryPool(VkDevice d, VkQueryPool qh, uint32_t first, uint32_t n)
{
	struct jb j = {0};
	jb_printf(&j, "{\"op\":\"vkResetQueryPool\",\"queryPool\":%u,\"firstQuery\":%u,\"queryCount\":%u}", HANDLE(struct kw_qpool, qh)->id, first, n);
	send_msg(DEV(d), &j, NULL, 0);
}
static API VkResult CALL kw_vkGetQueryPoolResults(VkDevice dh, VkQueryPool qh, uint32_t first, uint32_t n, size_t sz, void *p, VkDeviceSize stride,
	VkQueryResultFlags fl)
{
	struct kw_device *d = DEV(dh);
	struct kw_qpool *q = HANDLE(struct kw_qpool, qh);
	if (!n)
		return VK_SUCCESS;
	struct jb j = {0};
	jb_printf(&j, "{\"op\":\"getQueryPoolResults\",\"queryPool\":%u,\"firstQuery\":%u,\"queryCount\":%u}", q->id, first, n);
	struct kw_reply *rep = link_call(d->link, &j, NULL, 0);
	jb_free(&j);
	if (kw_reply_lost(d->link, rep, "vkGetQueryPoolResults")) {
		reply_free(rep);
		return VK_ERROR_DEVICE_LOST;
	}
	/* statistics queries have one value per enabled statistic */
	uint32_t nvals = q->type == VK_QUERY_TYPE_PIPELINE_STATISTICS ? (uint32_t)__builtin_popcount(q->stats) : 1;
	size_t vsize = (fl & VK_QUERY_RESULT_64_BIT) ? 8 : 4;
	const char *av = js_get(rep->json, "available");
	VkResult res = VK_SUCCESS;
	for (uint32_t i = 0; i < n; i++) {
		int avail = 0;
		if (av && *av == '[') { /* the i-th element */
			const char *x = av + 1;
			for (uint32_t k = 0; k < i && x && *x; k++) {
				x = js_skip(x);
				while (*x == ',' || *x == ' ')
					x++;
			}
			avail = js_num(x, 0) != 0;
		}
		uint64_t v = 0;
		if (rep->bin && (size_t)(i + 1) * 8 <= rep->binlen)
			memcpy(&v, rep->bin + (size_t)i * 8, 8);
		char *dst = (char *)p + (size_t)i * stride;
		if ((size_t)i * stride + (nvals + !!(fl & VK_QUERY_RESULT_WITH_AVAILABILITY_BIT)) * vsize > sz)
			break;
		for (uint32_t k = 0; k < nvals; k++) {
			uint64_t val = k ? 0 : v;
			if (avail || (fl & VK_QUERY_RESULT_PARTIAL_BIT)) {
				if (vsize == 8)
					memcpy(dst + k * 8, &val, 8);
				else {
					uint32_t v32 = (uint32_t)val;
					memcpy(dst + k * 4, &v32, 4);
				}
			}
		}
		if (fl & VK_QUERY_RESULT_WITH_AVAILABILITY_BIT) {
			uint64_t a64 = avail;
			uint32_t a32 = avail;
			memcpy(dst + nvals * vsize, vsize == 8 ? (void *)&a64 : (void *)&a32, vsize);
		}
		if (!avail)
			res = VK_NOT_READY;
	}
	reply_free(rep);
	return res;
}

/* ---- command pools and buffers ---- */

static API VkResult CALL kw_vkCreateCommandPool(VkDevice d, const VkCommandPoolCreateInfo *ci, const VkAllocationCallbacks *a, VkCommandPool *out)
{
	(void)d, (void)ci, (void)a;
	*out = (VkCommandPool)(uintptr_t)calloc(1, sizeof(struct kw_cmdpool));
	return VK_SUCCESS;
}

static void cb_reset(struct kw_cmdbuf *cb)
{
	jb_reset(&cb->cmds);
	cb->nwritten = 0;
	cb->nreads = 0;
	memset(cb->pipe, 0, sizeof cb->pipe);
	memset(cb->sets, 0, sizeof cb->sets);
	memset(cb->ndyn, 0, sizeof cb->ndyn);
	cb->bad[0] = 0;
}

/* the command buffer cannot run as recorded: vkQueueSubmit of it loses the device */
static void cb_bad(struct kw_cmdbuf *cb, const char *fmt, ...) __attribute__((format(printf, 2, 3)));
static void cb_bad(struct kw_cmdbuf *cb, const char *fmt, ...)
{
	if (cb->bad[0])
		return;
	va_list ap;
	va_start(ap, fmt);
	vsnprintf(cb->bad, sizeof cb->bad, fmt, ap);
	va_end(ap);
	kw_err("a command buffer %s: submitting it will lose the device", cb->bad);
}

static void cb_free(struct kw_cmdbuf *cb)
{
	struct kw_cmdpool *p = cb->pool;
	if (cb->prev)
		cb->prev->next = cb->next;
	else
		p->bufs = cb->next;
	if (cb->next)
		cb->next->prev = cb->prev;
	jb_free(&cb->cmds);
	free(cb->written);
	free(cb->reads);
	free(cb);
}

static API void CALL kw_vkDestroyCommandPool(VkDevice d, VkCommandPool ph, const VkAllocationCallbacks *a)
{
	(void)d, (void)a;
	struct kw_cmdpool *p = HANDLE(struct kw_cmdpool, ph);
	if (!p)
		return;
	while (p->bufs)
		cb_free(p->bufs);
	free(p);
}

static API void CALL kw_vkTrimCommandPool(VkDevice d, VkCommandPool p, VkCommandPoolTrimFlags f) { (void)d, (void)p, (void)f; }

static API VkResult CALL kw_vkResetCommandPool(VkDevice d, VkCommandPool ph, VkCommandPoolResetFlags f)
{
	(void)d, (void)f;
	for (struct kw_cmdbuf *cb = HANDLE(struct kw_cmdpool, ph)->bufs; cb; cb = cb->next)
		cb_reset(cb);
	return VK_SUCCESS;
}

static API VkResult CALL kw_vkAllocateCommandBuffers(VkDevice dh, const VkCommandBufferAllocateInfo *ai, VkCommandBuffer *out)
{
	struct kw_cmdpool *p = HANDLE(struct kw_cmdpool, ai->commandPool);
	for (uint32_t i = 0; i < ai->commandBufferCount; i++) {
		struct kw_cmdbuf *cb = calloc(1, sizeof *cb);
		set_loader_magic_value(cb);
		cb->dev = DEV(dh);
		cb->pool = p;
		cb->next = p->bufs;
		if (p->bufs)
			p->bufs->prev = cb;
		p->bufs = cb;
		out[i] = (VkCommandBuffer)cb;
	}
	return VK_SUCCESS;
}

static API void CALL kw_vkFreeCommandBuffers(VkDevice d, VkCommandPool p, uint32_t n, const VkCommandBuffer *cbs)
{
	(void)d, (void)p;
	for (uint32_t i = 0; i < n; i++)
		if (cbs[i])
			cb_free((struct kw_cmdbuf *)cbs[i]);
}

#define CB(h) ((struct kw_cmdbuf *)(h))

static API VkResult CALL kw_vkBeginCommandBuffer(VkCommandBuffer c, const VkCommandBufferBeginInfo *bi)
{
	(void)bi;
	cb_reset(CB(c));
	return VK_SUCCESS;
}
static API VkResult CALL kw_vkEndCommandBuffer(VkCommandBuffer c)
{
	(void)c;
	return VK_SUCCESS;
}
static API VkResult CALL kw_vkResetCommandBuffer(VkCommandBuffer c, VkCommandBufferResetFlags f)
{
	(void)f;
	cb_reset(CB(c));
	return VK_SUCCESS;
}

/*
 * The GPU may write [lo, hi) of b (hi past the end: to its end). A range may
 * only be narrower than the buffer where the command says exactly what it
 * writes; when unsure, the whole buffer (vk/PROTOCOL.md, readBuffer).
 */
#define KW_WHOLE UINT64_MAX
static void cb_list_add(struct kw_written **list, size_t *n, size_t *cap, struct kw_buffer *b, uint64_t lo, uint64_t hi)
{
	/* device-only memory has no guest copy: nothing to flush or read back */
	if (!b || (b->mem && !b->mem->shadow))
		return;
	uint64_t end = (b->size + 3) & ~3ull; /* host buffers are rounded up to 4 */
	if (hi > end)
		hi = end;
	lo &= ~3ull;
	if (lo >= hi)
		return;
	for (size_t i = 0; i < *n; i++)
		if ((*list)[i].buf == b) {
			kw_ranges_add(&(*list)[i].r, lo, hi);
			return;
		}
	if (*n == *cap) {
		*cap = *cap ? *cap * 2 : 16;
		*list = realloc(*list, *cap * sizeof **list);
		if (!*list)
			abort();
	}
	struct kw_written *w = &(*list)[(*n)++];
	w->buf = b;
	w->r.n = 0;
	kw_ranges_add(&w->r, lo, hi);
}
static void cb_written_range(struct kw_cmdbuf *cb, struct kw_buffer *b, uint64_t lo, uint64_t hi)
{
	cb_list_add(&cb->written, &cb->nwritten, &cb->capwritten, b, lo, hi);
}
static void cb_written(struct kw_cmdbuf *cb, struct kw_buffer *b) { cb_written_range(cb, b, 0, KW_WHOLE); }
/* the GPU may read [lo, hi) of b: flushed at submit (when host-visible) */
static void cb_read_range(struct kw_cmdbuf *cb, struct kw_buffer *b, uint64_t lo, uint64_t hi)
{
	cb_list_add(&cb->reads, &cb->nreads, &cb->capreads, b, lo, hi);
}

/* a buffer descriptor as bound: [offset + dynamic offset, + range); 0 when
 * its dynamic offset is not kept (then: the whole buffer) */
static int slot_range(const struct kw_dslot *v, const uint32_t *dyn, uint32_t ndyn, uint64_t *lo, uint64_t *hi)
{
	struct kw_buffer *b = v->buf;
	uint64_t off = v->offset;
	if (v->dyn >= 0) {
		if ((uint32_t)v->dyn >= ndyn) { /* offsets not kept: all of it */
			*lo = 0;
			*hi = KW_WHOLE;
			return 0;
		}
		off += dyn[v->dyn];
	}
	/* VK_WHOLE_SIZE: the size minus the descriptor's offset, from the dynamic offset on */
	uint64_t range = v->range == VK_WHOLE_SIZE ? (b->size > v->offset ? b->size - v->offset : 0) : v->range;
	*lo = off;
	*hi = range > KW_WHOLE - off ? KW_WHOLE : off + range;
	return 1;
}

/* starts a command object: {"c":"name" */
static struct jb *cmd(VkCommandBuffer c, const char *name)
{
	struct jb *b = &CB(c)->cmds;
	if (b->n)
		JS(b, ",");
	JS(b, "{\"c\":\"");
	jb_put(b, name, strlen(name));
	JS(b, "\"");
	return b;
}
#define BUFID(h) (HANDLE(struct kw_buffer, h) ? HANDLE(struct kw_buffer, h)->id : 0)
#define OID(h) oid((uint64_t)(uintptr_t)(h))

static API void CALL kw_vkCmdBeginRenderPass(VkCommandBuffer c, const VkRenderPassBeginInfo *rp, VkSubpassContents contents)
{
	uint32_t fb = fb_begin(CB(c)->dev, rp);
	struct jb *b = cmd(c, "vkCmdBeginRenderPass");
	jb_printf(b, ",\"renderPass\":%u,\"framebuffer\":%u,\"renderArea\":", OID(rp->renderPass), fb);
	j_rect(b, rp->renderArea);
	JS(b, ",\"clearValues\":[");
	for (uint32_t i = 0; i < rp->clearValueCount; i++) {
		if (i)
			JS(b, ",");
		j_cvalue(b, &rp->pClearValues[i]);
	}
	jb_printf(b, "],\"contents\":%u}", contents);
}
static API void CALL kw_vkCmdNextSubpass(VkCommandBuffer c, VkSubpassContents contents)
{
	jb_printf(cmd(c, "vkCmdNextSubpass"), ",\"contents\":%u}", contents);
}
static API void CALL kw_vkCmdEndRenderPass(VkCommandBuffer c) { JS(cmd(c, "vkCmdEndRenderPass"), "}"); }

static API void CALL kw_vkCmdBindPipeline(VkCommandBuffer c, VkPipelineBindPoint bp, VkPipeline p)
{
	struct jb *b = cmd(c, "vkCmdBindPipeline");
	JU(b, ",\"pipelineBindPoint\":", bp);
	JU(b, ",\"pipeline\":", OID(p));
	JS(b, "}");
	struct kw_pipe *kp = HANDLE(struct kw_pipe, p);
	if (bp <= 1)
		CB(c)->pipe[bp] = kp;
	if (kp && kp->bad)
		cb_bad(CB(c), "binds pipeline (id %u), which cannot run on WebGPU (%s)", kp->id, kp->bad);
}

/* at a draw or dispatch: the bound sets' buffers may be read, and their
 * storage buffers that the bound pipeline may write become GPU-written (all
 * of them when unsure) */
static void mark_written(VkCommandBuffer c, int bp)
{
	struct kw_cmdbuf *cb = CB(c);
	struct kw_pipe *p = cb->pipe[bp];
	for (int s = 0; s < KW_MAX_SETS; s++) {
		struct kw_dset *ds = cb->sets[bp][s];
		if (!ds)
			continue;
		for (size_t k = 0; k < ds->nslots; k++) {
			const struct kw_dslot *v = &ds->slots[k];
			if (!v->buf || (v->buf->mem && !v->buf->mem->shadow))
				continue;
			uint64_t lo, hi;
			slot_range(v, cb->dyn[bp][s], cb->ndyn[bp][s], &lo, &hi);
			cb_read_range(cb, v->buf, lo, hi);
			if (!v->storage)
				continue;
			int w = !p || p->nw < 0;
			for (int i = 0; !w && i < p->nw; i++)
				w = p->w[i] == ((uint32_t)s << 16 | (v->binding & 0xffff));
			if (w)
				cb_written_range(cb, v->buf, lo, hi);
		}
	}
}

static API void CALL kw_vkCmdBindDescriptorSets(VkCommandBuffer c, VkPipelineBindPoint bp, VkPipelineLayout layout, uint32_t first,
	uint32_t n, const VkDescriptorSet *sets, uint32_t ndyn, const uint32_t *dyn)
{
	struct jb *b = cmd(c, "vkCmdBindDescriptorSets");
	JU(b, ",\"pipelineBindPoint\":", bp);
	JU(b, ",\"layout\":", OID(layout));
	JU(b, ",\"firstSet\":", first);
	JS(b, ",\"descriptorSets\":[");
	uint32_t di = 0; /* the sets' dynamic offsets follow one another, in set order */
	for (uint32_t i = 0; i < n; i++) {
		struct kw_dset *s = HANDLE(struct kw_dset, sets[i]);
		if (i)
			JS(b, ",");
		jb_u64(b, s ? s->id : 0);
		uint32_t nd = 0;
		if (s && s->layout && s->layout->n) {
			const struct kw_dsl_binding *lb = &s->layout->b[s->layout->n - 1];
			nd = lb->dyn + (lb->type == VK_DESCRIPTOR_TYPE_UNIFORM_BUFFER_DYNAMIC ||
						lb->type == VK_DESCRIPTOR_TYPE_STORAGE_BUFFER_DYNAMIC
					? lb->count
					: 0);
		}
		uint32_t have = di < ndyn ? ndyn - di : 0;
		if (have > nd)
			have = nd;
		if (bp <= 1 && first + i < KW_MAX_SETS) {
			CB(c)->sets[bp][first + i] = s;
			uint32_t keep = have < KW_MAX_DYN ? have : KW_MAX_DYN; /* past KW_MAX_DYN: whole buffers */
			if (keep)
				memcpy(CB(c)->dyn[bp][first + i], dyn + di, keep * sizeof *dyn);
			CB(c)->ndyn[bp][first + i] = keep;
		} else if (s) /* another bind point: mark them all now */
			for (size_t k = 0; k < s->nslots; k++) {
				cb_written(CB(c), s->slots[k].buf);
				cb_read_range(CB(c), s->slots[k].buf, 0, KW_WHOLE);
			}
		di += nd;
	}
	JS(b, "],\"dynamicOffsets\":");
	j_u32s(b, dyn, ndyn);
	JS(b, "}");
}

static API void CALL kw_vkCmdBindVertexBuffers(VkCommandBuffer c, uint32_t first, uint32_t n, const VkBuffer *bufs, const VkDeviceSize *offs)
{
	struct jb *b = cmd(c, "vkCmdBindVertexBuffers");
	for (uint32_t i = 0; i < n; i++)
		cb_read_range(CB(c), HANDLE(struct kw_buffer, bufs[i]), offs[i], KW_WHOLE);
	jb_printf(b, ",\"firstBinding\":%u,\"buffers\":[", first);
	for (uint32_t i = 0; i < n; i++)
		jb_printf(b, i ? ",%u" : "%u", BUFID(bufs[i]));
	JS(b, "],\"offsets\":[");
	for (uint32_t i = 0; i < n; i++)
		jb_printf(b, i ? ",%llu" : "%llu", (unsigned long long)offs[i]);
	JS(b, "]}");
}

static API void CALL kw_vkCmdBindIndexBuffer(VkCommandBuffer c, VkBuffer buf, VkDeviceSize off, VkIndexType t)
{
	cb_read_range(CB(c), HANDLE(struct kw_buffer, buf), off, KW_WHOLE);
	jb_printf(cmd(c, "vkCmdBindIndexBuffer"), ",\"buffer\":%u,\"offset\":%llu,\"indexType\":%u}", BUFID(buf), (unsigned long long)off, t);
}

static API void CALL kw_vkCmdSetViewport(VkCommandBuffer c, uint32_t first, uint32_t n, const VkViewport *v)
{
	struct jb *b = cmd(c, "vkCmdSetViewport");
	jb_printf(b, ",\"firstViewport\":%u,\"viewports\":[", first);
	for (uint32_t i = 0; i < n; i++) {
		if (i)
			JS(b, ",");
		j_viewport(b, &v[i]);
	}
	JS(b, "]}");
}

static API void CALL kw_vkCmdSetScissor(VkCommandBuffer c, uint32_t first, uint32_t n, const VkRect2D *r)
{
	struct jb *b = cmd(c, "vkCmdSetScissor");
	jb_printf(b, ",\"firstScissor\":%u,\"scissors\":[", first);
	for (uint32_t i = 0; i < n; i++) {
		if (i)
			JS(b, ",");
		j_rect(b, r[i]);
	}
	JS(b, "]}");
}

static API void CALL kw_vkCmdSetLineWidth(VkCommandBuffer c, float w)
{
	struct jb *b = cmd(c, "vkCmdSetLineWidth");
	JS(b, ",\"lineWidth\":");
	jb_float(b, w);
	JS(b, "}");
}
static API void CALL kw_vkCmdSetDepthBias(VkCommandBuffer c, float k, float cl, float s)
{
	struct jb *b = cmd(c, "vkCmdSetDepthBias");
	JS(b, ",\"depthBiasConstantFactor\":");
	jb_float(b, k);
	JS(b, ",\"depthBiasClamp\":");
	jb_float(b, cl);
	JS(b, ",\"depthBiasSlopeFactor\":");
	jb_float(b, s);
	JS(b, "}");
}
static API void CALL kw_vkCmdSetBlendConstants(VkCommandBuffer c, const float bc[4])
{
	struct jb *b = cmd(c, "vkCmdSetBlendConstants");
	JS(b, ",\"blendConstants\":");
	j_floats(b, bc, 4);
	JS(b, "}");
}
static API void CALL kw_vkCmdSetDepthBounds(VkCommandBuffer c, float mn, float mx)
{
	struct jb *b = cmd(c, "vkCmdSetDepthBounds");
	JS(b, ",\"minDepthBounds\":");
	jb_float(b, mn);
	JS(b, ",\"maxDepthBounds\":");
	jb_float(b, mx);
	JS(b, "}");
}
static API void CALL kw_vkCmdSetStencilCompareMask(VkCommandBuffer c, VkStencilFaceFlags f, uint32_t m)
{
	jb_printf(cmd(c, "vkCmdSetStencilCompareMask"), ",\"faceMask\":%u,\"compareMask\":%u}", f, m);
}
static API void CALL kw_vkCmdSetStencilWriteMask(VkCommandBuffer c, VkStencilFaceFlags f, uint32_t m)
{
	jb_printf(cmd(c, "vkCmdSetStencilWriteMask"), ",\"faceMask\":%u,\"writeMask\":%u}", f, m);
}
static API void CALL kw_vkCmdSetStencilReference(VkCommandBuffer c, VkStencilFaceFlags f, uint32_t r)
{
	jb_printf(cmd(c, "vkCmdSetStencilReference"), ",\"faceMask\":%u,\"reference\":%u}", f, r);
}

/* BaseVertex/BaseInstance read 0 on WebGPU: rendering approximations are
 * kept (vkd3d needs VK_KHR_shader_draw_parameters), with this warning */
static void base_warn(VkCommandBuffer c, const char *call, int nonzero)
{
	struct kw_pipe *p = CB(c)->pipe[0];
	if (nonzero && p && p->base)
		kw_err("%s: the pipeline's shaders read BaseVertex/BaseInstance, which read 0 on WebGPU: wrong values with a non-zero "
		       "first vertex, vertex offset or first instance", call);
}

static API void CALL kw_vkCmdDraw(VkCommandBuffer c, uint32_t vc, uint32_t ic, uint32_t fv, uint32_t fi)
{
	base_warn(c, "vkCmdDraw", fv || fi);
	mark_written(c, 0);
	jb_printf(cmd(c, "vkCmdDraw"), ",\"vertexCount\":%u,\"instanceCount\":%u,\"firstVertex\":%u,\"firstInstance\":%u}", vc, ic, fv, fi);
}
static API void CALL kw_vkCmdDrawIndexed(VkCommandBuffer c, uint32_t n, uint32_t ic, uint32_t fi, int32_t vo, uint32_t finst)
{
	base_warn(c, "vkCmdDrawIndexed", vo || finst);
	mark_written(c, 0);
	jb_printf(cmd(c, "vkCmdDrawIndexed"), ",\"indexCount\":%u,\"instanceCount\":%u,\"firstIndex\":%u,\"vertexOffset\":%d,\"firstInstance\":%u}",
		  n, ic, fi, vo, finst);
}
static API void CALL kw_vkCmdDrawIndirect(VkCommandBuffer c, VkBuffer buf, VkDeviceSize off, uint32_t n, uint32_t stride)
{
	mark_written(c, 0);
	cb_read_range(CB(c), HANDLE(struct kw_buffer, buf), off, KW_WHOLE);
	jb_printf(cmd(c, "vkCmdDrawIndirect"), ",\"buffer\":%u,\"offset\":%llu,\"drawCount\":%u,\"stride\":%u}", BUFID(buf),
		  (unsigned long long)off, n, stride);
}
static API void CALL kw_vkCmdDrawIndexedIndirect(VkCommandBuffer c, VkBuffer buf, VkDeviceSize off, uint32_t n, uint32_t stride)
{
	mark_written(c, 0);
	cb_read_range(CB(c), HANDLE(struct kw_buffer, buf), off, KW_WHOLE);
	jb_printf(cmd(c, "vkCmdDrawIndexedIndirect"), ",\"buffer\":%u,\"offset\":%llu,\"drawCount\":%u,\"stride\":%u}", BUFID(buf),
		  (unsigned long long)off, n, stride);
}
static API void CALL kw_vkCmdDispatch(VkCommandBuffer c, uint32_t x, uint32_t y, uint32_t z)
{
	mark_written(c, 1);
	struct jb *b = cmd(c, "vkCmdDispatch");
	JU(b, ",\"groupCountX\":", x);
	JU(b, ",\"groupCountY\":", y);
	JU(b, ",\"groupCountZ\":", z);
	JS(b, "}");
}
static API void CALL kw_vkCmdDispatchIndirect(VkCommandBuffer c, VkBuffer buf, VkDeviceSize off)
{
	mark_written(c, 1);
	cb_read_range(CB(c), HANDLE(struct kw_buffer, buf), off, KW_WHOLE);
	jb_printf(cmd(c, "vkCmdDispatchIndirect"), ",\"buffer\":%u,\"offset\":%llu}", BUFID(buf), (unsigned long long)off);
}

static API void CALL kw_vkCmdCopyBuffer(VkCommandBuffer c, VkBuffer src, VkBuffer dst, uint32_t n, const VkBufferCopy *r)
{
	struct jb *b = cmd(c, "vkCmdCopyBuffer");
	JU(b, ",\"srcBuffer\":", BUFID(src));
	JU(b, ",\"dstBuffer\":", BUFID(dst));
	JS(b, ",\"regions\":[");
	for (uint32_t i = 0; i < n; i++) {
		if (i)
			JS(b, ",");
		JU(b, "{\"srcOffset\":", r[i].srcOffset);
		JU(b, ",\"dstOffset\":", r[i].dstOffset);
		JU(b, ",\"size\":", r[i].size);
		JS(b, "}");
		/* the host writes exactly [dstOffset, dstOffset + size) */
		cb_written_range(CB(c), HANDLE(struct kw_buffer, dst), r[i].dstOffset, r[i].dstOffset + r[i].size);
		cb_read_range(CB(c), HANDLE(struct kw_buffer, src), r[i].srcOffset, r[i].srcOffset + r[i].size);
	}
	JS(b, "]}");
}

static API void CALL kw_vkCmdCopyImage(VkCommandBuffer c, VkImage src, VkImageLayout sl, VkImage dst, VkImageLayout dl, uint32_t n, const VkImageCopy *r)
{
	struct jb *b = cmd(c, "vkCmdCopyImage");
	jb_printf(b, ",\"srcImage\":%u,\"srcImageLayout\":%u,\"dstImage\":%u,\"dstImageLayout\":%u,\"regions\":[", OID(src), sl, OID(dst), dl);
	for (uint32_t i = 0; i < n; i++) {
		(i ? JS(b, ",{\"srcSubresource\":") : JS(b, "{\"srcSubresource\":"));
		j_layers(b, &r[i].srcSubresource);
		JS(b, ",\"srcOffset\":");
		j_off3(b, r[i].srcOffset);
		JS(b, ",\"dstSubresource\":");
		j_layers(b, &r[i].dstSubresource);
		JS(b, ",\"dstOffset\":");
		j_off3(b, r[i].dstOffset);
		JS(b, ",\"extent\":");
		j_ext3(b, r[i].extent);
		JS(b, "}");
	}
	JS(b, "]}");
}

static API void CALL kw_vkCmdBlitImage(VkCommandBuffer c, VkImage src, VkImageLayout sl, VkImage dst, VkImageLayout dl, uint32_t n,
	const VkImageBlit *r, VkFilter filter)
{
	struct jb *b = cmd(c, "vkCmdBlitImage");
	jb_printf(b, ",\"srcImage\":%u,\"srcImageLayout\":%u,\"dstImage\":%u,\"dstImageLayout\":%u,\"regions\":[", OID(src), sl, OID(dst), dl);
	for (uint32_t i = 0; i < n; i++) {
		(i ? JS(b, ",{\"srcSubresource\":") : JS(b, "{\"srcSubresource\":"));
		j_layers(b, &r[i].srcSubresource);
		JS(b, ",\"srcOffsets\":[");
		j_off3(b, r[i].srcOffsets[0]);
		JS(b, ",");
		j_off3(b, r[i].srcOffsets[1]);
		JS(b, "],\"dstSubresource\":");
		j_layers(b, &r[i].dstSubresource);
		JS(b, ",\"dstOffsets\":[");
		j_off3(b, r[i].dstOffsets[0]);
		JS(b, ",");
		j_off3(b, r[i].dstOffsets[1]);
		JS(b, "]}");
	}
	jb_printf(b, "],\"filter\":%u}", filter);
}

static void j_bic(struct jb *b, const VkBufferImageCopy *r, uint32_t n)
{
	JS(b, ",\"regions\":[");
	for (uint32_t i = 0; i < n; i++) {
		jb_printf(b, "%s{\"bufferOffset\":%llu,\"bufferRowLength\":%u,\"bufferImageHeight\":%u,\"imageSubresource\":", i ? "," : "",
			  (unsigned long long)r[i].bufferOffset, r[i].bufferRowLength, r[i].bufferImageHeight);
		j_layers(b, &r[i].imageSubresource);
		JS(b, ",\"imageOffset\":");
		j_off3(b, r[i].imageOffset);
		JS(b, ",\"imageExtent\":");
		j_ext3(b, r[i].imageExtent);
		JS(b, "}");
	}
	JS(b, "]}");
}

static API void CALL kw_vkCmdCopyBufferToImage(VkCommandBuffer c, VkBuffer src, VkImage dst, VkImageLayout dl, uint32_t n, const VkBufferImageCopy *r)
{
	struct jb *b = cmd(c, "vkCmdCopyBufferToImage");
	jb_printf(b, ",\"srcBuffer\":%u,\"dstImage\":%u,\"dstImageLayout\":%u", BUFID(src), OID(dst), dl);
	j_bic(b, r, n);
	/* from each region's bufferOffset to the end (as vkCmdCopyImageToBuffer's writes) */
	for (uint32_t i = 0; i < n; i++)
		cb_read_range(CB(c), HANDLE(struct kw_buffer, src), r[i].bufferOffset, KW_WHOLE);
}

static API void CALL kw_vkCmdCopyImageToBuffer(VkCommandBuffer c, VkImage src, VkImageLayout sl, VkBuffer dst, uint32_t n, const VkBufferImageCopy *r)
{
	struct jb *b = cmd(c, "vkCmdCopyImageToBuffer");
	jb_printf(b, ",\"srcImage\":%u,\"srcImageLayout\":%u,\"dstBuffer\":%u", OID(src), sl, BUFID(dst));
	j_bic(b, r, n);
	/* from each region's bufferOffset to the end (the footprint needs the
	 * format's block size, which the ICD does not keep) */
	for (uint32_t i = 0; i < n; i++)
		cb_written_range(CB(c), HANDLE(struct kw_buffer, dst), r[i].bufferOffset, KW_WHOLE);
}

static API void CALL kw_vkCmdUpdateBuffer(VkCommandBuffer c, VkBuffer dst, VkDeviceSize off, VkDeviceSize size, const void *data)
{
	struct jb *b = cmd(c, "vkCmdUpdateBuffer");
	jb_printf(b, ",\"dstBuffer\":%u,\"dstOffset\":%llu,\"data\":", BUFID(dst), (unsigned long long)off);
	j_bytes(b, data, size);
	JS(b, "}");
	cb_written_range(CB(c), HANDLE(struct kw_buffer, dst), off, off + size);
}

static API void CALL kw_vkCmdFillBuffer(VkCommandBuffer c, VkBuffer dst, VkDeviceSize off, VkDeviceSize size, uint32_t data)
{
	struct jb *b = cmd(c, "vkCmdFillBuffer");
	jb_printf(b, ",\"dstBuffer\":%u,\"dstOffset\":%llu,\"size\":", BUFID(dst), (unsigned long long)off);
	j_size(b, size);
	jb_printf(b, ",\"data\":%u}", data);
	cb_written_range(CB(c), HANDLE(struct kw_buffer, dst), off, size == VK_WHOLE_SIZE || size > KW_WHOLE - off ? KW_WHOLE : off + size);
}

static void j_ranges(struct jb *b, const VkImageSubresourceRange *r, uint32_t n)
{
	JS(b, ",\"ranges\":[");
	for (uint32_t i = 0; i < n; i++) {
		if (i)
			JS(b, ",");
		j_range(b, &r[i]);
	}
	JS(b, "]}");
}

static API void CALL kw_vkCmdClearColorImage(VkCommandBuffer c, VkImage im, VkImageLayout l, const VkClearColorValue *col, uint32_t n, const VkImageSubresourceRange *r)
{
	struct jb *b = cmd(c, "vkCmdClearColorImage");
	jb_printf(b, ",\"image\":%u,\"imageLayout\":%u,\"color\":", OID(im), l);
	j_ccolor(b, col);
	j_ranges(b, r, n);
}

static API void CALL kw_vkCmdClearDepthStencilImage(VkCommandBuffer c, VkImage im, VkImageLayout l, const VkClearDepthStencilValue *ds, uint32_t n, const VkImageSubresourceRange *r)
{
	struct jb *b = cmd(c, "vkCmdClearDepthStencilImage");
	jb_printf(b, ",\"image\":%u,\"imageLayout\":%u,\"depthStencil\":", OID(im), l);
	j_cds(b, ds);
	j_ranges(b, r, n);
}

static API void CALL kw_vkCmdClearAttachments(VkCommandBuffer c, uint32_t na, const VkClearAttachment *a, uint32_t nr, const VkClearRect *r)
{
	struct jb *b = cmd(c, "vkCmdClearAttachments");
	JS(b, ",\"attachments\":[");
	for (uint32_t i = 0; i < na; i++) {
		jb_printf(b, "%s{\"aspectMask\":%u,\"colorAttachment\":%u,\"clearValue\":", i ? "," : "", a[i].aspectMask, a[i].colorAttachment);
		j_cvalue(b, &a[i].clearValue);
		JS(b, "}");
	}
	JS(b, "],\"rects\":[");
	for (uint32_t i = 0; i < nr; i++) {
		(i ? JS(b, ",{\"rect\":") : JS(b, "{\"rect\":"));
		j_rect(b, r[i].rect);
		jb_printf(b, ",\"baseArrayLayer\":%u,\"layerCount\":%u}", r[i].baseArrayLayer, r[i].layerCount);
	}
	JS(b, "]}");
}

static API void CALL kw_vkCmdResolveImage(VkCommandBuffer c, VkImage src, VkImageLayout sl, VkImage dst, VkImageLayout dl, uint32_t n, const VkImageResolve *r)
{
	struct jb *b = cmd(c, "vkCmdResolveImage");
	jb_printf(b, ",\"srcImage\":%u,\"srcImageLayout\":%u,\"dstImage\":%u,\"dstImageLayout\":%u,\"regions\":[", OID(src), sl, OID(dst), dl);
	for (uint32_t i = 0; i < n; i++) {
		(i ? JS(b, ",{\"srcSubresource\":") : JS(b, "{\"srcSubresource\":"));
		j_layers(b, &r[i].srcSubresource);
		JS(b, ",\"srcOffset\":");
		j_off3(b, r[i].srcOffset);
		JS(b, ",\"dstSubresource\":");
		j_layers(b, &r[i].dstSubresource);
		JS(b, ",\"dstOffset\":");
		j_off3(b, r[i].dstOffset);
		JS(b, ",\"extent\":");
		j_ext3(b, r[i].extent);
		JS(b, "}");
	}
	JS(b, "]}");
}

static API void CALL kw_vkCmdPushConstants(VkCommandBuffer c, VkPipelineLayout l, VkShaderStageFlags st, uint32_t off, uint32_t size, const void *v)
{
	struct jb *b = cmd(c, "vkCmdPushConstants");
	JU(b, ",\"layout\":", OID(l));
	JU(b, ",\"stageFlags\":", st);
	JU(b, ",\"offset\":", off);
	JS(b, ",\"values\":");
	j_bytes(b, v, size);
	JS(b, "}");
}

static API void CALL kw_vkCmdExecuteCommands(VkCommandBuffer c, uint32_t n, const VkCommandBuffer *cbs)
{
	struct kw_cmdbuf *p = CB(c);
	for (uint32_t i = 0; i < n; i++) {
		struct kw_cmdbuf *s = CB(cbs[i]);
		if (!s->cmds.n)
			continue;
		if (p->cmds.n)
			JS(&p->cmds, ",");
		jb_put(&p->cmds, s->cmds.p, s->cmds.n);
		for (size_t k = 0; k < s->nwritten; k++)
			for (int q = 0; q < s->written[k].r.n; q++)
				cb_written_range(p, s->written[k].buf, s->written[k].r.lo[q], s->written[k].r.hi[q]);
		for (size_t k = 0; k < s->nreads; k++)
			for (int q = 0; q < s->reads[k].r.n; q++)
				cb_read_range(p, s->reads[k].buf, s->reads[k].r.lo[q], s->reads[k].r.hi[q]);
		if (s->bad[0] && !p->bad[0])
			snprintf(p->bad, sizeof p->bad, "%s", s->bad);
	}
}

/* barriers, events, queries: nothing to record */
static API void CALL kw_vkCmdPipelineBarrier(VkCommandBuffer c, VkPipelineStageFlags s, VkPipelineStageFlags d, VkDependencyFlags f,
	uint32_t a, const VkMemoryBarrier *b, uint32_t bc, const VkBufferMemoryBarrier *bb, uint32_t ic, const VkImageMemoryBarrier *ib)
{
	(void)c, (void)s, (void)d, (void)f, (void)a, (void)b, (void)bc, (void)bb, (void)ic, (void)ib;
}
static API void CALL kw_vkCmdSetEvent(VkCommandBuffer c, VkEvent e, VkPipelineStageFlags s) { (void)c, (void)e, (void)s; }
static API void CALL kw_vkCmdResetEvent(VkCommandBuffer c, VkEvent e, VkPipelineStageFlags s) { (void)c, (void)e, (void)s; }
static API void CALL kw_vkCmdWaitEvents(VkCommandBuffer c, uint32_t n, const VkEvent *e, VkPipelineStageFlags s, VkPipelineStageFlags d,
	uint32_t a, const VkMemoryBarrier *b, uint32_t bc, const VkBufferMemoryBarrier *bb, uint32_t ic, const VkImageMemoryBarrier *ib)
{
	(void)c, (void)n, (void)e, (void)s, (void)d, (void)a, (void)b, (void)bc, (void)bb, (void)ic, (void)ib;
}
#define QID(h) (HANDLE(struct kw_qpool, h) ? HANDLE(struct kw_qpool, h)->id : 0)
static API void CALL kw_vkCmdBeginQuery(VkCommandBuffer c, VkQueryPool q, uint32_t i, VkQueryControlFlags f)
{
	jb_printf(cmd(c, "vkCmdBeginQuery"), ",\"queryPool\":%u,\"query\":%u,\"flags\":%u}", QID(q), i, f);
}
static API void CALL kw_vkCmdEndQuery(VkCommandBuffer c, VkQueryPool q, uint32_t i)
{
	jb_printf(cmd(c, "vkCmdEndQuery"), ",\"queryPool\":%u,\"query\":%u}", QID(q), i);
}
static API void CALL kw_vkCmdResetQueryPool(VkCommandBuffer c, VkQueryPool q, uint32_t f, uint32_t n)
{
	jb_printf(cmd(c, "vkCmdResetQueryPool"), ",\"queryPool\":%u,\"firstQuery\":%u,\"queryCount\":%u}", QID(q), f, n);
}
static API void CALL kw_vkCmdWriteTimestamp(VkCommandBuffer c, VkPipelineStageFlagBits s, VkQueryPool q, uint32_t i)
{
	jb_printf(cmd(c, "vkCmdWriteTimestamp"), ",\"pipelineStage\":%u,\"queryPool\":%u,\"query\":%u}", s, QID(q), i);
}
static API void CALL kw_vkCmdCopyQueryPoolResults(VkCommandBuffer c, VkQueryPool q, uint32_t f, uint32_t n, VkBuffer b, VkDeviceSize o, VkDeviceSize s,
	VkQueryResultFlags fl)
{
	jb_printf(cmd(c, "vkCmdCopyQueryPoolResults"), ",\"queryPool\":%u,\"firstQuery\":%u,\"queryCount\":%u,\"dstBuffer\":%u,\"dstOffset\":%llu,"
		  "\"stride\":%llu,\"flags\":%u}", QID(q), f, n, BUFID(b), (unsigned long long)o, (unsigned long long)s, fl);
	/* query i at o + i * stride: a value (8 bytes with 64-bit results, else 4), plus availability */
	uint64_t one = (fl & VK_QUERY_RESULT_64_BIT ? 8 : 4) * (fl & VK_QUERY_RESULT_WITH_AVAILABILITY_BIT ? 2 : 1);
	if (n)
		cb_written_range(CB(c), HANDLE(struct kw_buffer, b), o, o + (uint64_t)(n - 1) * (s ? s : one) + one);
}

/* ---- queue ---- */

/* a batch's VkTimelineSemaphoreSubmitInfo, or NULL */
static const VkTimelineSemaphoreSubmitInfo *tl_info(const VkSubmitInfo *si)
{
	for (const VkBaseInStructure *s = si->pNext; s; s = s->pNext)
		if (s->sType == VK_STRUCTURE_TYPE_TIMELINE_SEMAPHORE_SUBMIT_INFO)
			return (const void *)s;
	return NULL;
}

/* the timeline semaphore and value of a batch's k-th signal (wait), or NULL */
static struct kw_sem *tl_signal(const VkSubmitInfo *si, const VkTimelineSemaphoreSubmitInfo *t, uint32_t k, uint64_t *v)
{
	struct kw_sem *sem = t && k < t->signalSemaphoreValueCount ? HANDLE(struct kw_sem, si->pSignalSemaphores[k]) : NULL;
	if (!sem || !sem->timeline)
		return NULL;
	*v = t->pSignalSemaphoreValues[k];
	return sem;
}
static struct kw_sem *tl_wait(const VkSubmitInfo *si, const VkTimelineSemaphoreSubmitInfo *t, uint32_t k, uint64_t *v)
{
	struct kw_sem *sem = t && k < t->waitSemaphoreValueCount ? HANDLE(struct kw_sem, si->pWaitSemaphores[k]) : NULL;
	if (!sem || !sem->timeline)
		return NULL;
	*v = t->pWaitSemaphoreValues[k];
	return sem;
}

/*
 * A submit held in the ICD: a batch that waits for a timeline value that
 * nothing sent or signalled has given yet, or one after it (the queue runs
 * in submission order). The command buffers are pending, so the app keeps
 * them as they are until the submit completes.
 */
struct kw_held {
	struct kw_held *next;
	struct kw_fence *fence; /* on the last batch of a vkQueueSubmit */
	uint32_t ncb, nwait, nsig;
	struct kw_cmdbuf **cbs;
	struct kw_tlsig *wait, *sig;
};

/* q_mu held: a device lost with submits held: they are dropped, their
 * fences signaled (every wait reports the loss) */
static void held_drop_locked(struct kw_device *d)
{
	while (d->held) {
		struct kw_held *h = d->held;
		d->held = h->next;
		if (h->fence) {
			h->fence->signaled = 1;
			__atomic_store_n(&h->fence->held, 0, __ATOMIC_RELEASE);
		}
		free(h);
	}
	d->held_tail = &d->held;
	pthread_cond_broadcast(&d->q_cv);
}

/* a semaphore or fence the app destroys: no held submit refers to it */
static void held_forget(struct kw_device *d, const void *obj)
{
	pthread_mutex_lock(&d->q_mu);
	for (struct kw_held *h = d->held; h; h = h->next) {
		if (h->fence == obj)
			h->fence = NULL;
		for (uint32_t k = 0; k < h->nwait; k++)
			if (h->wait[k].sem == obj)
				h->wait[k].sem = NULL;
		for (uint32_t k = 0; k < h->nsig; k++)
			if (h->sig[k].sem == obj)
				h->sig[k].sem = NULL;
	}
	pthread_mutex_unlock(&d->q_mu);
}

static void tl_reached(struct kw_device *d, uint64_t seq)
{
	pthread_mutex_lock(&sem_mu);
	tl_reach_locked(d, seq);
	pthread_mutex_unlock(&sem_mu);
}

/*
 * Sends one vkQueueSubmit of the command buffers, signalling the timeline
 * values `sig` and the fence f; under q_mu, in queue order.
 */
static void submit_send(struct kw_device *d, struct kw_cmdbuf *const *cbs, uint32_t ncb, const struct kw_tlsig *sig, uint32_t nsig, struct kw_fence *f)
{
	if (f && f->r)
		fence_complete(d, f);
	struct kw_tlpend *e = NULL;
	if (nsig) {
		e = calloc(1, sizeof *e + nsig * sizeof *sig);
		if (!e)
			abort();
		e->n = nsig;
		memcpy(e->sig, sig, nsig * sizeof *sig);
	}
	/* mark GPU-written buffers and send under one lock, so no readback
	 * (another thread's fence wait) slips between: it would read the data
	 * from before this submit and clear the mark */
	pthread_mutex_lock(&d->mu);
	/* host-visible memory: CPU writes to what these commands may read or
	 * write, not every mapped byte (ggml keeps hundreds of MiB mapped) */
	int64_t t0 = kw_now();
	for (uint32_t k = 0; k < ncb; k++) {
		flush_list(d, cbs[k]->reads, cbs[k]->nreads);
		flush_list(d, cbs[k]->written, cbs[k]->nwritten);
	}
	kw_stats.flush_ns += kw_now() - t0;
	t0 = kw_now();
	struct jb j = {0};
	JS(&j, "{\"op\":\"vkQueueSubmit\",\"cmds\":[");
	int any = 0;
	int writes_mapped = 0; /* the GPU may write host-visible memory (the lists hold no device-only buffer) */
	for (uint32_t k = 0; k < ncb; k++) {
		struct kw_cmdbuf *cb = cbs[k];
		if (cb->cmds.n) {
			if (any)
				JS(&j, ",");
			jb_put(&j, cb->cmds.p, cb->cmds.n);
			any = 1;
		}
		for (size_t w = 0; w < cb->nwritten; w++)
			for (int q = 0; q < cb->written[w].r.n; q++)
				kw_ranges_add(&cb->written[w].buf->dirty, cb->written[w].r.lo[q], cb->written[w].r.hi[q]);
		writes_mapped |= cb->nwritten > 0;
	}
	JS(&j, "]}");
	uint64_t seq = ++d->seq;
	/* the rule fences have (vk/PROTOCOL.md, Amendments, "Fences at
	 * submit"): what may write memory the app can read is done at its reply */
	int slow = d->fence_sync || writes_mapped;
	uint32_t fast = 0;
	if (f)
		f->seq = seq;
	if (f && slow) {
		f->signaled = 0;
		f->polls = 0;
		f->r = link_send(d->link, &j, NULL, 0, 1);
	} else if (f) {
		/* nothing the app can read changes: the fence signals now (mapped
		 * memory that earlier work wrote is read back after the wait by
		 * requests the host answers in order, after this work, once its
		 * validation is known) */
		fast = link_send(d->link, &j, NULL, 0, 1);
		f->r = 0;
		f->signaled = 1;
	} else {
		link_send(d->link, &j, NULL, 0, 0);
	}
	if (e) {
		e->seq = seq;
		if (slow) { /* its values are reached at this reply */
			struct jb s = {0};
			JS(&s, "{\"op\":\"sync\"}");
			e->r = link_send(d->link, &s, NULL, 0, 1);
			jb_free(&s);
		}
	}
	pthread_mutex_unlock(&d->mu);
	while (fast) {
		pthread_mutex_lock(&d->fl_mu);
		if (d->ninflight < KW_INFLIGHT) {
			d->inflight[d->ninflight++] = fast;
			fast = 0;
		}
		pthread_mutex_unlock(&d->fl_mu);
		if (fast)
			inflight_reap(d, KW_INFLIGHT - 1); /* full: wait for the oldest */
	}
	if (e) {
		pthread_mutex_lock(&sem_mu);
		for (uint32_t k = 0; k < nsig; k++)
			if (sig[k].sem && sig[k].value > sig[k].sem->submitted)
				sig[k].sem->submitted = sig[k].value;
		if (slow) {
			struct kw_tlpend **pp = &d->tl;
			while (*pp)
				pp = &(*pp)->next;
			*pp = e;
		} else {
			/* reached at the submit, as are the values of earlier submits */
			for (uint32_t k = 0; k < nsig; k++)
				sem_raise(sig[k].sem, sig[k].value);
			free(e);
			tl_reach_locked(d, seq);
		}
		pthread_cond_broadcast(&sem_cv);
		pthread_mutex_unlock(&sem_mu);
	}
	kw_stats.submit_json += j.n;
	kw_stats.submits++;
	jb_free(&j);
	kw_stats.submit_ns += kw_now() - t0;
}

/* q_mu held: may the held submit h go (every value it waits for given)? */
static int held_ready(const struct kw_held *h)
{
	int ok = 1;
	pthread_mutex_lock(&sem_mu);
	for (uint32_t k = 0; k < h->nwait && ok; k++)
		ok = !h->wait[k].sem || h->wait[k].value <= h->wait[k].sem->submitted;
	pthread_mutex_unlock(&sem_mu);
	return ok;
}

/* q_mu held: the held submits that may go now, in order */
static void held_pump(struct kw_device *d)
{
	while (d->held) {
		if (d->link->dead) {
			held_drop_locked(d);
			return;
		}
		struct kw_held *h = d->held;
		if (!held_ready(h))
			return;
		d->held = h->next;
		if (!d->held)
			d->held_tail = &d->held;
		submit_send(d, h->cbs, h->ncb, h->sig, h->nsig, h->fence);
		if (h->fence)
			__atomic_store_n(&h->fence->held, 0, __ATOMIC_RELEASE);
		free(h);
		pthread_cond_broadcast(&d->q_cv);
	}
}

VkResult kw_queue_unhold(struct kw_device *d, const char *call)
{
	pthread_mutex_lock(&d->q_mu);
	int64_t t0 = mono_ns();
	int said = 0;
	while (d->held && !d->link->dead) {
		if (!said && mono_ns() - t0 > 1000000000) {
			kw_log("%s waits for submits held until timeline values are signalled", call);
			said = 1;
		}
		cv_wait_ns(&d->q_cv, &d->q_mu, 20000000);
		link_poll(d->link, 0); /* a lost device's last frame, when it has come */
	}
	if (d->link->dead)
		held_drop_locked(d);
	pthread_mutex_unlock(&d->q_mu);
	return d->link->dead ? VK_ERROR_DEVICE_LOST : VK_SUCCESS;
}

/* the batches si[0..n) of one vkQueueSubmit, sent as one message */
static void submit_batches(struct kw_device *d, const VkSubmitInfo *si, uint32_t n, struct kw_fence *f)
{
	struct kw_cmdbuf *cb_stack[16], **cbs = cb_stack;
	struct kw_tlsig sig_stack[8], *sig = sig_stack;
	uint32_t ncb = 0, nsig = 0;
	for (uint32_t i = 0; i < n; i++) {
		ncb += si[i].commandBufferCount;
		nsig += si[i].signalSemaphoreCount;
	}
	if (ncb > 16 && !(cbs = malloc(ncb * sizeof *cbs)))
		abort();
	if (nsig > 8 && !(sig = malloc(nsig * sizeof *sig)))
		abort();
	ncb = nsig = 0;
	for (uint32_t i = 0; i < n; i++) {
		for (uint32_t k = 0; k < si[i].commandBufferCount; k++)
			cbs[ncb++] = CB(si[i].pCommandBuffers[k]);
		const VkTimelineSemaphoreSubmitInfo *t = tl_info(&si[i]);
		for (uint32_t k = 0; k < si[i].signalSemaphoreCount; k++) {
			uint64_t v;
			struct kw_sem *sem = tl_signal(&si[i], t, k, &v);
			if (sem)
				sig[nsig++] = (struct kw_tlsig){sem, v};
		}
	}
	submit_send(d, cbs, ncb, sig, nsig, f);
	if (cbs != cb_stack)
		free(cbs);
	if (sig != sig_stack)
		free(sig);
}

/* q_mu held: how many of the batches may go now, the first n that wait for
 * no timeline value beyond what sent work, the host or an earlier batch of
 * this call gives */
static uint32_t submit_ready(const VkSubmitInfo *si, uint32_t n)
{
	uint32_t i;
	pthread_mutex_lock(&sem_mu);
	for (i = 0; i < n; i++) {
		const VkTimelineSemaphoreSubmitInfo *t = tl_info(&si[i]);
		int ok = 1;
		for (uint32_t k = 0; k < si[i].waitSemaphoreCount && ok; k++) {
			uint64_t v, sv;
			struct kw_sem *sem = tl_wait(&si[i], t, k, &v);
			if (!sem || v <= sem->submitted)
				continue;
			ok = 0;
			for (uint32_t b = 0; b < i && !ok; b++) {
				const VkTimelineSemaphoreSubmitInfo *tb = tl_info(&si[b]);
				for (uint32_t m = 0; m < si[b].signalSemaphoreCount && !ok; m++)
					ok = tl_signal(&si[b], tb, m, &sv) == sem && sv >= v;
			}
		}
		if (!ok)
			break;
	}
	pthread_mutex_unlock(&sem_mu);
	return i;
}

/* q_mu held: the batches si[0..n) held, the fence f with the last (or alone) */
static void hold_batches(struct kw_device *d, const VkSubmitInfo *si, uint32_t n, struct kw_fence *f)
{
	for (uint32_t i = 0; i < n || (i == 0 && f); i++) {
		const VkSubmitInfo *b = n ? &si[i] : NULL;
		uint32_t ncb = b ? b->commandBufferCount : 0, nw = b ? b->waitSemaphoreCount : 0, ns = b ? b->signalSemaphoreCount : 0;
		struct kw_held *h = calloc(1, sizeof *h + ncb * sizeof *h->cbs + (nw + ns) * sizeof(struct kw_tlsig));
		if (!h)
			abort();
		h->sig = (struct kw_tlsig *)(h + 1);
		h->wait = h->sig + ns;
		h->cbs = (struct kw_cmdbuf **)(h->wait + nw);
		const VkTimelineSemaphoreSubmitInfo *t = b ? tl_info(b) : NULL;
		for (uint32_t k = 0; k < ncb; k++)
			h->cbs[h->ncb++] = CB(b->pCommandBuffers[k]);
		for (uint32_t k = 0; k < nw; k++) {
			uint64_t v;
			struct kw_sem *sem = tl_wait(b, t, k, &v);
			if (sem)
				h->wait[h->nwait++] = (struct kw_tlsig){sem, v};
		}
		for (uint32_t k = 0; k < ns; k++) {
			uint64_t v;
			struct kw_sem *sem = tl_signal(b, t, k, &v);
			if (sem)
				h->sig[h->nsig++] = (struct kw_tlsig){sem, v};
		}
		if (f && (n == 0 || i == n - 1)) {
			h->fence = f;
			f->signaled = 0;
			f->r = 0;
			f->polls = 0;
			__atomic_store_n(&f->held, 1, __ATOMIC_RELEASE);
		}
		kw_log("vkQueueSubmit: a batch held in the ICD (%u timeline waits, the first for value %llu)", h->nwait,
		       h->nwait ? (unsigned long long)h->wait[0].value : 0ull);
		*d->held_tail = h;
		d->held_tail = &h->next;
		if (n == 0)
			break;
	}
}

static API VkResult CALL kw_vkQueueSubmit(VkQueue qh, uint32_t n, const VkSubmitInfo *si, VkFence fh)
{
	struct kw_device *d = ((struct kw_queue *)qh)->dev;
	struct kw_fence *f = HANDLE(struct kw_fence, fh);
	if (d->link->dead)
		return VK_ERROR_DEVICE_LOST;
	/* a command buffer recorded something the host cannot run: the work
	 * would be wrong or missing, so the device is lost instead */
	for (uint32_t i = 0; i < n; i++)
		for (uint32_t k = 0; k < si[i].commandBufferCount; k++) {
			struct kw_cmdbuf *cb = CB(si[i].pCommandBuffers[k]);
			if (cb->bad[0]) {
				char why[512];
				snprintf(why, sizeof why, "vkQueueSubmit: the command buffer %s", cb->bad);
				link_lose(d->link, why);
				return VK_ERROR_DEVICE_LOST;
			}
		}
	if (f && f->r)
		fence_complete(d, f);
	tl_poll(d); /* replies to earlier timeline signals that have come */
	pthread_mutex_lock(&d->q_mu);
	/* wait before signal: from the first batch that waits for a timeline
	 * value nothing has given yet, this submit and every later one are held
	 * (held_pump releases them) */
	uint32_t go = d->held ? 0 : submit_ready(si, n);
	if (go == n && !d->held) {
		submit_batches(d, si, n, f);
	} else {
		if (go)
			submit_batches(d, si, go, NULL);
		hold_batches(d, si + go, n - go, f);
	}
	pthread_mutex_unlock(&d->q_mu);
	if (kw_stats_on < 0)
		kw_stats_on = getenv("KWVK_STATS") != NULL;
	if (kw_stats_on)
		kw_stats_tick();
	return d->link->dead ? VK_ERROR_DEVICE_LOST : VK_SUCCESS;
}

static VkResult kw_sync(struct kw_device *d, const char *call)
{
	/* the submits held in the ICD first (another thread's vkSignalSemaphore releases them) */
	if (kw_queue_unhold(d, call) != VK_SUCCESS)
		return VK_ERROR_DEVICE_LOST;
	struct jb j = {0};
	JS(&j, "{\"op\":\"sync\"}");
	pthread_mutex_lock(&d->q_mu);
	uint64_t seq = d->seq;
	uint32_t r = link_send(d->link, &j, NULL, 0, 1);
	pthread_mutex_unlock(&d->q_mu);
	jb_free(&j);
	struct kw_reply *rep = link_wait(d->link, r);
	int lost = kw_reply_lost(d->link, rep, "waiting for the queue");
	reply_free(rep);
	if (!lost) {
		inflight_reap(d, KW_INFLIGHT); /* answered by now: a failed one loses the device */
		tl_reached(d, seq); /* every timeline value sent before */
		tl_poll(d);
	}
	if (lost || d->link->dead)
		return VK_ERROR_DEVICE_LOST;
	kw_readback(d, NULL);
	return d->link->dead ? VK_ERROR_DEVICE_LOST : VK_SUCCESS;
}

static API VkResult CALL kw_vkQueueWaitIdle(VkQueue q) { return kw_sync(((struct kw_queue *)q)->dev, "vkQueueWaitIdle"); }
static API VkResult CALL kw_vkDeviceWaitIdle(VkDevice d) { return kw_sync(DEV(d), "vkDeviceWaitIdle"); }

static API VkResult CALL kw_vkQueueBindSparse(VkQueue q, uint32_t n, const VkBindSparseInfo *b, VkFence f)
{
	(void)q, (void)n, (void)b, (void)f;
	return VK_ERROR_FEATURE_NOT_PRESENT;
}

/* ---- Vulkan 1.1 core and device extensions ---- */

/* zero a pNext struct's body (after sType and pNext) */
#define ZBODY(p, T) memset((char *)(p) + offsetof(T, pNext) + sizeof(void *), 0, sizeof(T) - offsetof(T, pNext) - sizeof(void *))

static API void CALL kw_vkGetPhysicalDeviceFeatures2(VkPhysicalDevice pd, VkPhysicalDeviceFeatures2 *f)
{
	f->features = PD(pd)->features;
	for (VkBaseOutStructure *s = (VkBaseOutStructure *)f->pNext; s; s = s->pNext) {
		switch (s->sType) {
		case VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_DYNAMIC_RENDERING_FEATURES:
			((VkPhysicalDeviceDynamicRenderingFeatures *)s)->dynamicRendering = VK_TRUE;
			break;
		case VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_EXTENDED_DYNAMIC_STATE_FEATURES_EXT:
			((VkPhysicalDeviceExtendedDynamicStateFeaturesEXT *)s)->extendedDynamicState = VK_TRUE;
			break;
		case VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_VULKAN_1_1_FEATURES: {
			VkPhysicalDeviceVulkan11Features *x = (void *)s;
			ZBODY(x, VkPhysicalDeviceVulkan11Features);
			/* the translator emulates 16-bit storage-buffer members as u32 words */
			x->storageBuffer16BitAccess = VK_TRUE;
			x->shaderDrawParameters = VK_TRUE;
			break;
		}
		case VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_VULKAN_1_2_FEATURES: {
			VkPhysicalDeviceVulkan12Features *x = (void *)s;
			ZBODY(x, VkPhysicalDeviceVulkan12Features);
			x->hostQueryReset = VK_TRUE;
			x->timelineSemaphore = VK_TRUE;
			x->imagelessFramebuffer = VK_TRUE; /* vkCreateFramebuffer, fb_begin */
			x->separateDepthStencilLayouts = VK_TRUE; /* the host keeps no layouts */
			/* no stage has subgroup operations (supportedStages 0), so
			 * none takes these types or a dynamic broadcast id */
			x->shaderSubgroupExtendedTypes = VK_TRUE;
			x->subgroupBroadcastDynamicId = VK_TRUE;
			x->shaderFloat16 = PD(pd)->f16;
			x->storageBuffer8BitAccess = VK_TRUE; /* emulated as u32 words too */
			break;
		}
		case VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_SHADER_FLOAT16_INT8_FEATURES: {
			VkPhysicalDeviceShaderFloat16Int8Features *x = (void *)s;
			x->shaderFloat16 = PD(pd)->f16;
			x->shaderInt8 = VK_FALSE;
			break;
		}
		case VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_HOST_QUERY_RESET_FEATURES:
			((VkPhysicalDeviceHostQueryResetFeatures *)s)->hostQueryReset = VK_TRUE;
			break;
		case VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_TIMELINE_SEMAPHORE_FEATURES:
			((VkPhysicalDeviceTimelineSemaphoreFeatures *)s)->timelineSemaphore = VK_TRUE;
			break;
		case VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_IMAGELESS_FRAMEBUFFER_FEATURES:
			((VkPhysicalDeviceImagelessFramebufferFeatures *)s)->imagelessFramebuffer = VK_TRUE;
			break;
		case VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_SEPARATE_DEPTH_STENCIL_LAYOUTS_FEATURES:
			((VkPhysicalDeviceSeparateDepthStencilLayoutsFeatures *)s)->separateDepthStencilLayouts = VK_TRUE;
			break;
		case VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_SHADER_SUBGROUP_EXTENDED_TYPES_FEATURES:
			((VkPhysicalDeviceShaderSubgroupExtendedTypesFeatures *)s)->shaderSubgroupExtendedTypes = VK_TRUE;
			break;
		case VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_BUFFER_DEVICE_ADDRESS_FEATURES:
			ZBODY(s, VkPhysicalDeviceBufferDeviceAddressFeatures);
			break;
		case VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_8BIT_STORAGE_FEATURES:
			ZBODY(s, VkPhysicalDevice8BitStorageFeatures);
			((VkPhysicalDevice8BitStorageFeatures *)s)->storageBuffer8BitAccess = VK_TRUE;
			break;
		case VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_VULKAN_MEMORY_MODEL_FEATURES:
			ZBODY(s, VkPhysicalDeviceVulkanMemoryModelFeatures);
			break;
		case VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_DESCRIPTOR_INDEXING_FEATURES:
			ZBODY(s, VkPhysicalDeviceDescriptorIndexingFeatures);
			break;
		case VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_SCALAR_BLOCK_LAYOUT_FEATURES:
			ZBODY(s, VkPhysicalDeviceScalarBlockLayoutFeatures);
			break;
		case VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_VULKAN_1_3_FEATURES:
			ZBODY(s, VkPhysicalDeviceVulkan13Features);
			((VkPhysicalDeviceVulkan13Features *)s)->dynamicRendering = VK_TRUE;
			break;
		case VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_16BIT_STORAGE_FEATURES:
			ZBODY(s, VkPhysicalDevice16BitStorageFeatures);
			((VkPhysicalDevice16BitStorageFeatures *)s)->storageBuffer16BitAccess = VK_TRUE;
			break;
		case VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_MULTIVIEW_FEATURES:
			ZBODY(s, VkPhysicalDeviceMultiviewFeatures);
			break;
		case VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_VARIABLE_POINTERS_FEATURES:
			ZBODY(s, VkPhysicalDeviceVariablePointersFeatures);
			break;
		case VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_PROTECTED_MEMORY_FEATURES:
			ZBODY(s, VkPhysicalDeviceProtectedMemoryFeatures);
			break;
		case VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_SAMPLER_YCBCR_CONVERSION_FEATURES:
			ZBODY(s, VkPhysicalDeviceSamplerYcbcrConversionFeatures);
			break;
		case VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_SHADER_DRAW_PARAMETERS_FEATURES:
			/* the capability is accepted (vkd3d requires it); BaseVertex and
			 * BaseInstance read 0 (a draw with non-zero bases warns) */
			((VkPhysicalDeviceShaderDrawParametersFeatures *)s)->shaderDrawParameters = VK_TRUE;
			break;
		default:
			break;
		}
	}
}

/* VkPhysicalDeviceDriverProperties, also in VkPhysicalDeviceVulkan12Properties. */
#define KW_DRIVER_ID VK_DRIVER_ID_MESA_VENUS /* no own id; a virtual GPU's */
#define KW_DRIVER_NAME "kwvk"
#define KW_DRIVER_INFO "unkernel Vulkan on WebGPU"
#define KW_CONFORMANCE ((VkConformanceVersion){1, 1, 0, 0})
/* timeline values are 64-bit counters in the guest with no window of their
 * own (struct kw_sem): any difference */
#define KW_TIMELINE_DIFF UINT64_MAX

static API void CALL kw_vkGetPhysicalDeviceProperties2(VkPhysicalDevice pdh, VkPhysicalDeviceProperties2 *p)
{
	struct kw_physical_device *pd = PD(pdh);
	p->properties = pd->props;
	for (VkBaseOutStructure *s = (VkBaseOutStructure *)p->pNext; s; s = s->pNext) {
		switch (s->sType) {
		case VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_ID_PROPERTIES: {
			VkPhysicalDeviceIDProperties *x = (void *)s;
			ZBODY(x, VkPhysicalDeviceIDProperties);
			memcpy(x->deviceUUID, "kwvk-device-0001", 16);
			memcpy(x->driverUUID, "kwvk-driver-0001", 16);
			break;
		}
		case VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_DRIVER_PROPERTIES: {
			VkPhysicalDeviceDriverProperties *x = (void *)s;
			ZBODY(x, VkPhysicalDeviceDriverProperties);
			x->driverID = KW_DRIVER_ID;
			snprintf(x->driverName, sizeof x->driverName, KW_DRIVER_NAME);
			snprintf(x->driverInfo, sizeof x->driverInfo, "%s%s%s", KW_DRIVER_INFO, *pd->adapter ? ": " : "", pd->adapter);
			x->conformanceVersion = KW_CONFORMANCE;
			break;
		}
		case VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_VULKAN_1_2_PROPERTIES: {
			/* What a 1.2 caller reads in place of the structures above
			 * (vulkaninfo's driver rows). The rest stays zero: no descriptor
			 * indexing, no minmax filtering. */
			VkPhysicalDeviceVulkan12Properties *x = (void *)s;
			ZBODY(x, VkPhysicalDeviceVulkan12Properties);
			x->driverID = KW_DRIVER_ID;
			snprintf(x->driverName, sizeof x->driverName, KW_DRIVER_NAME);
			snprintf(x->driverInfo, sizeof x->driverInfo, "%s%s%s", KW_DRIVER_INFO, *pd->adapter ? ": " : "", pd->adapter);
			x->conformanceVersion = KW_CONFORMANCE;
			x->denormBehaviorIndependence = VK_SHADER_FLOAT_CONTROLS_INDEPENDENCE_NONE;
			x->roundingModeIndependence = VK_SHADER_FLOAT_CONTROLS_INDEPENDENCE_NONE;
			x->supportedDepthResolveModes = VK_RESOLVE_MODE_SAMPLE_ZERO_BIT;
			x->supportedStencilResolveModes = VK_RESOLVE_MODE_SAMPLE_ZERO_BIT;
			x->framebufferIntegerColorSampleCounts = VK_SAMPLE_COUNT_1_BIT;
			x->maxTimelineSemaphoreValueDifference = KW_TIMELINE_DIFF;
			break;
		}
		case VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_TIMELINE_SEMAPHORE_PROPERTIES:
			((VkPhysicalDeviceTimelineSemaphoreProperties *)s)->maxTimelineSemaphoreValueDifference = KW_TIMELINE_DIFF;
			break;
		case VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_MAINTENANCE_3_PROPERTIES: {
			VkPhysicalDeviceMaintenance3Properties *x = (void *)s;
			x->maxPerSetDescriptors = 1024;
			x->maxMemoryAllocationSize = pd->max_alloc;
			break;
		}
		case VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_SUBGROUP_PROPERTIES: {
			VkPhysicalDeviceSubgroupProperties *x = (void *)s;
			x->subgroupSize = PD(pdh)->subgroup_size;
			x->supportedStages = 0;
			x->supportedOperations = VK_SUBGROUP_FEATURE_BASIC_BIT;
			x->quadOperationsInAllStages = VK_FALSE;
			break;
		}
		case VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_POINT_CLIPPING_PROPERTIES:
			((VkPhysicalDevicePointClippingProperties *)s)->pointClippingBehavior = VK_POINT_CLIPPING_BEHAVIOR_ALL_CLIP_PLANES;
			break;
		case VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_MULTIVIEW_PROPERTIES: {
			VkPhysicalDeviceMultiviewProperties *x = (void *)s;
			x->maxMultiviewViewCount = 1;
			x->maxMultiviewInstanceIndex = 0x7ffffff;
			break;
		}
		case VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_PROTECTED_MEMORY_PROPERTIES:
			((VkPhysicalDeviceProtectedMemoryProperties *)s)->protectedNoFault = VK_FALSE;
			break;
		case VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_DEPTH_STENCIL_RESOLVE_PROPERTIES: {
			VkPhysicalDeviceDepthStencilResolveProperties *x = (void *)s;
			x->supportedDepthResolveModes = VK_RESOLVE_MODE_SAMPLE_ZERO_BIT;
			x->supportedStencilResolveModes = VK_RESOLVE_MODE_SAMPLE_ZERO_BIT;
			x->independentResolveNone = VK_FALSE;
			x->independentResolve = VK_FALSE;
			break;
		}
		case VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_VULKAN_1_1_PROPERTIES: {
			VkPhysicalDeviceVulkan11Properties *x = (void *)s;
			ZBODY(x, VkPhysicalDeviceVulkan11Properties);
			memcpy(x->deviceUUID, "kwvk-device-0001", 16);
			memcpy(x->driverUUID, "kwvk-driver-0001", 16);
			x->subgroupSize = PD(pdh)->subgroup_size;
			x->subgroupSupportedOperations = VK_SUBGROUP_FEATURE_BASIC_BIT;
			x->pointClippingBehavior = VK_POINT_CLIPPING_BEHAVIOR_ALL_CLIP_PLANES;
			x->maxMultiviewViewCount = 1;
			x->maxMultiviewInstanceIndex = 0x7ffffff;
			x->maxPerSetDescriptors = 1024;
			x->maxMemoryAllocationSize = pd->max_alloc;
			break;
		}
		default:
			break;
		}
	}
}

static API void CALL kw_vkGetPhysicalDeviceMemoryProperties2(VkPhysicalDevice pd, VkPhysicalDeviceMemoryProperties2 *m) { m->memoryProperties = PD(pd)->mem; }
static API void CALL kw_vkGetPhysicalDeviceFormatProperties2(VkPhysicalDevice pd, VkFormat f, VkFormatProperties2 *p)
{
	kw_vkGetPhysicalDeviceFormatProperties(pd, f, &p->formatProperties);
}
static API VkResult CALL kw_vkGetPhysicalDeviceImageFormatProperties2(VkPhysicalDevice pd, const VkPhysicalDeviceImageFormatInfo2 *i, VkImageFormatProperties2 *p)
{
	for (VkBaseOutStructure *s = (VkBaseOutStructure *)p->pNext; s; s = s->pNext)
		if (s->sType == VK_STRUCTURE_TYPE_EXTERNAL_IMAGE_FORMAT_PROPERTIES)
			ZBODY(s, VkExternalImageFormatProperties);
	for (const VkBaseInStructure *s = (const VkBaseInStructure *)i->pNext; s; s = s->pNext)
		if (s->sType == VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_EXTERNAL_IMAGE_FORMAT_INFO &&
		    ((const VkPhysicalDeviceExternalImageFormatInfo *)s)->handleType)
			return VK_ERROR_FORMAT_NOT_SUPPORTED;
	return kw_vkGetPhysicalDeviceImageFormatProperties(pd, i->format, i->type, i->tiling, i->usage, i->flags, &p->imageFormatProperties);
}
static API void CALL kw_vkGetPhysicalDeviceQueueFamilyProperties2(VkPhysicalDevice pd, uint32_t *n, VkQueueFamilyProperties2 *out)
{
	if (!out) {
		*n = 1;
		return;
	}
	if (*n < 1)
		return;
	uint32_t one = 1;
	kw_vkGetPhysicalDeviceQueueFamilyProperties(pd, &one, &out[0].queueFamilyProperties);
	*n = 1;
}
static API void CALL kw_vkGetPhysicalDeviceSparseImageFormatProperties2(VkPhysicalDevice pd, const VkPhysicalDeviceSparseImageFormatInfo2 *i,
	uint32_t *n, VkSparseImageFormatProperties2 *p)
{
	(void)pd, (void)i, (void)p;
	*n = 0;
}

static API VkResult CALL kw_vkEnumerateInstanceVersion(uint32_t *v)
{
	*v = VK_API_VERSION_1_2;
	return VK_SUCCESS;
}

static API VkResult CALL kw_vkEnumeratePhysicalDeviceGroups(VkInstance i, uint32_t *n, VkPhysicalDeviceGroupProperties *out)
{
	struct kw_instance *inst = (struct kw_instance *)i;
	if (!out) {
		*n = 1;
		return VK_SUCCESS;
	}
	if (*n < 1)
		return VK_INCOMPLETE;
	*n = 1;
	out->physicalDeviceCount = 1;
	memset(out->physicalDevices, 0, sizeof out->physicalDevices);
	out->physicalDevices[0] = (VkPhysicalDevice)&inst->pd;
	out->subsetAllocation = VK_FALSE;
	return VK_SUCCESS;
}

/* external handles: none supported */
static API void CALL kw_vkGetPhysicalDeviceExternalBufferProperties(VkPhysicalDevice pd, const VkPhysicalDeviceExternalBufferInfo *i, VkExternalBufferProperties *p)
{
	(void)pd, (void)i;
	ZBODY(p, VkExternalBufferProperties);
}
static API void CALL kw_vkGetPhysicalDeviceExternalFenceProperties(VkPhysicalDevice pd, const VkPhysicalDeviceExternalFenceInfo *i, VkExternalFenceProperties *p)
{
	(void)pd, (void)i;
	ZBODY(p, VkExternalFenceProperties);
}
static API void CALL kw_vkGetPhysicalDeviceExternalSemaphoreProperties(VkPhysicalDevice pd, const VkPhysicalDeviceExternalSemaphoreInfo *i, VkExternalSemaphoreProperties *p)
{
	(void)pd, (void)i;
	ZBODY(p, VkExternalSemaphoreProperties);
}

static API void CALL kw_vkGetDeviceGroupPeerMemoryFeatures(VkDevice d, uint32_t h, uint32_t l, uint32_t r, VkPeerMemoryFeatureFlags *f)
{
	(void)d, (void)h, (void)l, (void)r;
	*f = VK_PEER_MEMORY_FEATURE_COPY_SRC_BIT | VK_PEER_MEMORY_FEATURE_COPY_DST_BIT;
}
static API void CALL kw_vkCmdSetDeviceMask(VkCommandBuffer c, uint32_t m) { (void)c, (void)m; }
static API void CALL kw_vkCmdDispatchBase(VkCommandBuffer c, uint32_t bx, uint32_t by, uint32_t bz, uint32_t x, uint32_t y, uint32_t z)
{
	/* WebGPU has no base workgroup: dispatching from 0 would compute the wrong part */
	if (bx || by || bz)
		cb_bad(CB(c), "records vkCmdDispatchBase with a non-zero base (%u, %u, %u), which is unsupported", bx, by, bz);
	kw_vkCmdDispatch(c, x, y, z);
}

static API void CALL kw_vkGetDescriptorSetLayoutSupport(VkDevice d, const VkDescriptorSetLayoutCreateInfo *ci, VkDescriptorSetLayoutSupport *s)
{
	(void)d;
	(void)ci;
	s->supported = VK_TRUE;
}

static API VkResult CALL kw_vkCreateSamplerYcbcrConversion(VkDevice d, const VkSamplerYcbcrConversionCreateInfo *ci, const VkAllocationCallbacks *a, VkSamplerYcbcrConversion *out)
{
	(void)d, (void)ci, (void)a, (void)out;
	return VK_ERROR_FEATURE_NOT_PRESENT;
}
static API void CALL kw_vkDestroySamplerYcbcrConversion(VkDevice d, VkSamplerYcbcrConversion c, const VkAllocationCallbacks *a) { (void)d, (void)c, (void)a; }

/* descriptor update templates: expanded into vkUpdateDescriptorSets */
struct kw_dtemplate {
	uint32_t n;
	VkDescriptorUpdateTemplateEntry e[];
};

static API VkResult CALL kw_vkCreateDescriptorUpdateTemplate(VkDevice d, const VkDescriptorUpdateTemplateCreateInfo *ci, const VkAllocationCallbacks *a,
	VkDescriptorUpdateTemplate *out)
{
	(void)d, (void)a;
	if (ci->templateType != VK_DESCRIPTOR_UPDATE_TEMPLATE_TYPE_DESCRIPTOR_SET) {
		kw_err("vkCreateDescriptorUpdateTemplate: push descriptor templates are unsupported (no VK_KHR_push_descriptor): "
		       "VK_ERROR_FEATURE_NOT_PRESENT");
		return VK_ERROR_FEATURE_NOT_PRESENT;
	}
	struct kw_dtemplate *t = malloc(sizeof *t + ci->descriptorUpdateEntryCount * sizeof t->e[0]);
	t->n = ci->descriptorUpdateEntryCount;
	memcpy(t->e, ci->pDescriptorUpdateEntries, t->n * sizeof t->e[0]);
	*out = (VkDescriptorUpdateTemplate)(uintptr_t)t;
	return VK_SUCCESS;
}
static API void CALL kw_vkDestroyDescriptorUpdateTemplate(VkDevice d, VkDescriptorUpdateTemplate t, const VkAllocationCallbacks *a)
{
	(void)d, (void)a;
	free(HANDLE(void, t));
}
static API void CALL kw_vkUpdateDescriptorSetWithTemplate(VkDevice d, VkDescriptorSet set, VkDescriptorUpdateTemplate th, const void *data)
{
	struct kw_dtemplate *t = HANDLE(struct kw_dtemplate, th);
	VkWriteDescriptorSet *w = calloc(t->n ? t->n : 1, sizeof *w);
	size_t total = 0;
	for (uint32_t i = 0; i < t->n; i++)
		total += t->e[i].descriptorCount;
	VkDescriptorImageInfo *ii = calloc(total ? total : 1, sizeof *ii);
	VkDescriptorBufferInfo *bi = calloc(total ? total : 1, sizeof *bi);
	VkBufferView *bv = calloc(total ? total : 1, sizeof *bv);
	size_t k = 0;
	for (uint32_t i = 0; i < t->n; i++) {
		const VkDescriptorUpdateTemplateEntry *e = &t->e[i];
		w[i] = (VkWriteDescriptorSet){.sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, .dstSet = set, .dstBinding = e->dstBinding,
			.dstArrayElement = e->dstArrayElement, .descriptorCount = e->descriptorCount, .descriptorType = e->descriptorType,
			.pImageInfo = &ii[k], .pBufferInfo = &bi[k], .pTexelBufferView = &bv[k]};
		for (uint32_t c = 0; c < e->descriptorCount; c++, k++) {
			const char *src = (const char *)data + e->offset + c * e->stride;
			switch (e->descriptorType) {
			case VK_DESCRIPTOR_TYPE_SAMPLER:
			case VK_DESCRIPTOR_TYPE_COMBINED_IMAGE_SAMPLER:
			case VK_DESCRIPTOR_TYPE_SAMPLED_IMAGE:
			case VK_DESCRIPTOR_TYPE_STORAGE_IMAGE:
			case VK_DESCRIPTOR_TYPE_INPUT_ATTACHMENT:
				memcpy(&ii[k], src, sizeof ii[k]);
				break;
			case VK_DESCRIPTOR_TYPE_UNIFORM_TEXEL_BUFFER:
			case VK_DESCRIPTOR_TYPE_STORAGE_TEXEL_BUFFER:
				memcpy(&bv[k], src, sizeof bv[k]);
				break;
			default:
				memcpy(&bi[k], src, sizeof bi[k]);
			}
		}
	}
	kw_vkUpdateDescriptorSets(d, t->n, w, 0, NULL);
	free(w);
	free(ii);
	free(bi);
	free(bv);
}

/* Vulkan 1.2 core entry points */

/* timeline semaphores (see struct kw_sem) */
static API VkResult CALL kw_vkGetSemaphoreCounterValue(VkDevice dh, VkSemaphore s, uint64_t *v)
{
	struct kw_device *d = DEV(dh);
	struct kw_sem *sem = HANDLE(struct kw_sem, s);
	/* no round trip: the replies that have come (a lost device's last frame
	 * among them), then the value reached */
	link_poll(d->link, 0);
	inflight_reap(d, KW_INFLIGHT);
	tl_poll(d);
	pthread_mutex_lock(&sem_mu);
	*v = sem->value;
	pthread_mutex_unlock(&sem_mu);
	/* what submitted work wrote to mapped memory, as at a fence wait */
	if (!d->link->dead)
		kw_readback(d, NULL);
	return d->link->dead ? VK_ERROR_DEVICE_LOST : VK_SUCCESS;
}
static API VkResult CALL kw_vkWaitSemaphores(VkDevice dh, const VkSemaphoreWaitInfo *i, uint64_t t)
{
	struct kw_device *d = DEV(dh);
	int64_t t0 = kw_now();
	int64_t end = t >= (uint64_t)INT64_MAX / 2 ? INT64_MAX : mono_ns() + (int64_t)t;
	int any = (i->flags & VK_SEMAPHORE_WAIT_ANY_BIT) != 0;
	VkResult res;
	inflight_reap(d, KW_INFLIGHT);
	tl_poll(d);
	for (;;) {
		link_poll(d->link, 0); /* a lost device's last frame, when it has come */
		uint32_t ok = 0, coming = 0;
		pthread_mutex_lock(&sem_mu);
		for (uint32_t k = 0; k < i->semaphoreCount; k++) {
			struct kw_sem *sem = HANDLE(struct kw_sem, i->pSemaphores[k]);
			if (sem->value >= i->pValues[k])
				ok++;
			else if (sem->submitted >= i->pValues[k])
				coming++; /* signalled by sent work: at a reply */
		}
		int done = ok == i->semaphoreCount || (ok && any);
		int64_t left = end - mono_ns();
		if (!done && !coming && !d->link->dead && left > 0) {
			/* a value only a host signal (another thread) or the release of
			 * a held submit gives */
			cv_wait_ns(&sem_cv, &sem_mu, left < 20000000 ? left : 20000000);
			pthread_mutex_unlock(&sem_mu);
			continue;
		}
		pthread_mutex_unlock(&sem_mu);
		if (d->link->dead) {
			res = VK_ERROR_DEVICE_LOST;
			break;
		}
		if (done) {
			res = VK_SUCCESS;
			break;
		}
		if (left <= 0) {
			res = VK_TIMEOUT;
			break;
		}
		tl_take(d, left < 20000000 ? left : 20000000);
	}
	inflight_reap(d, KW_INFLIGHT); /* replies that have come: a failed submit is a lost device */
	kw_stats.wait_ns += kw_now() - t0;
	if (res == VK_SUCCESS && !d->link->dead)
		kw_readback(d, NULL);
	return d->link->dead ? VK_ERROR_DEVICE_LOST : res;
}
static API VkResult CALL kw_vkSignalSemaphore(VkDevice dh, const VkSemaphoreSignalInfo *i)
{
	struct kw_device *d = DEV(dh);
	struct kw_sem *sem = HANDLE(struct kw_sem, i->semaphore);
	pthread_mutex_lock(&sem_mu);
	sem_raise(sem, i->value);
	if (i->value > sem->submitted)
		sem->submitted = i->value;
	pthread_cond_broadcast(&sem_cv);
	pthread_mutex_unlock(&sem_mu);
	/* submits held for it go now */
	pthread_mutex_lock(&d->q_mu);
	held_pump(d);
	pthread_mutex_unlock(&d->q_mu);
	return VK_SUCCESS;
}
static API VkDeviceAddress CALL kw_vkGetBufferDeviceAddress(VkDevice d, const VkBufferDeviceAddressInfo *i)
{
	(void)d, (void)i;
	kw_err("vkGetBufferDeviceAddress: buffer device addresses are unsupported (bufferDeviceAddress is false): returning 0");
	return 0;
}
static API uint64_t CALL kw_vkGetBufferOpaqueCaptureAddress(VkDevice d, const VkBufferDeviceAddressInfo *i)
{
	(void)d, (void)i;
	return 0;
}
static API uint64_t CALL kw_vkGetDeviceMemoryOpaqueCaptureAddress(VkDevice d, const VkDeviceMemoryOpaqueCaptureAddressInfo *i)
{
	(void)d, (void)i;
	return 0;
}
static API void CALL kw_vkCmdDrawIndirectCount(VkCommandBuffer c, VkBuffer b, VkDeviceSize o, VkBuffer cb, VkDeviceSize co, uint32_t m, uint32_t s)
{
	(void)b, (void)o, (void)cb, (void)co, (void)m, (void)s;
	cb_bad(CB(c), "records vkCmdDrawIndirectCount, which is unsupported (drawIndirectCount is false)");
}
static API void CALL kw_vkCmdDrawIndexedIndirectCount(VkCommandBuffer c, VkBuffer b, VkDeviceSize o, VkBuffer cb, VkDeviceSize co, uint32_t m, uint32_t s)
{
	(void)b, (void)o, (void)cb, (void)co, (void)m, (void)s;
	cb_bad(CB(c), "records vkCmdDrawIndexedIndirectCount, which is unsupported (drawIndirectCount is false)");
}

/* ---- render pass 2 ---- */

static void j_attref2(struct jb *j, const VkAttachmentReference2 *r)
{
	jb_printf(j, "{\"attachment\":%u,\"layout\":%u,\"aspectMask\":%u}", r->attachment, r->layout, r->aspectMask);
}
static void j_attrefs2(struct jb *j, const char *name, const VkAttachmentReference2 *r, uint32_t n)
{
	jb_printf(j, ",\"%s\":[", name);
	for (uint32_t i = 0; i < n; i++) {
		if (i)
			JS(j, ",");
		j_attref2(j, &r[i]);
	}
	JS(j, "]");
}

static API VkResult CALL kw_vkCreateRenderPass2(VkDevice dh, const VkRenderPassCreateInfo2 *ci, const VkAllocationCallbacks *a, VkRenderPass *out)
{
	(void)a;
	struct kw_device *d = DEV(dh);
	struct kw_obj *o = new_obj(d);
	struct jb j = {0};
	jb_printf(&j, "{\"op\":\"vkCreateRenderPass2\",\"id\":%u,\"attachments\":[", o->id);
	for (uint32_t i = 0; i < ci->attachmentCount; i++) {
		const VkAttachmentDescription2 *x = &ci->pAttachments[i];
		jb_printf(&j, "%s{\"flags\":%u,\"format\":%u,\"samples\":%u,\"loadOp\":%u,\"storeOp\":%u,\"stencilLoadOp\":%u,"
			      "\"stencilStoreOp\":%u,\"initialLayout\":%u,\"finalLayout\":%u}",
			  i ? "," : "", x->flags, x->format, x->samples, x->loadOp, x->storeOp, x->stencilLoadOp, x->stencilStoreOp,
			  x->initialLayout, x->finalLayout);
	}
	JS(&j, "],\"subpasses\":[");
	for (uint32_t i = 0; i < ci->subpassCount; i++) {
		const VkSubpassDescription2 *s = &ci->pSubpasses[i];
		jb_printf(&j, "%s{\"flags\":%u,\"pipelineBindPoint\":%u,\"viewMask\":%u", i ? "," : "", s->flags, s->pipelineBindPoint, s->viewMask);
		j_attrefs2(&j, "inputAttachments", s->pInputAttachments, s->inputAttachmentCount);
		j_attrefs2(&j, "colorAttachments", s->pColorAttachments, s->colorAttachmentCount);
		if (s->pResolveAttachments)
			j_attrefs2(&j, "resolveAttachments", s->pResolveAttachments, s->colorAttachmentCount);
		if (s->pDepthStencilAttachment) {
			JS(&j, ",\"depthStencilAttachment\":");
			j_attref2(&j, s->pDepthStencilAttachment);
		}
		for (const VkBaseInStructure *n = s->pNext; n; n = n->pNext)
			if (n->sType == VK_STRUCTURE_TYPE_SUBPASS_DESCRIPTION_DEPTH_STENCIL_RESOLVE) {
				const VkSubpassDescriptionDepthStencilResolve *r = (const void *)n;
				if (r->pDepthStencilResolveAttachment) {
					jb_printf(&j, ",\"depthResolveMode\":%u,\"stencilResolveMode\":%u,\"depthStencilResolveAttachment\":",
						  r->depthResolveMode, r->stencilResolveMode);
					j_attref2(&j, r->pDepthStencilResolveAttachment);
				}
			}
		JS(&j, ",\"preserveAttachments\":");
		j_u32s(&j, s->pPreserveAttachments, s->preserveAttachmentCount);
		JS(&j, "}");
	}
	JS(&j, "],\"dependencies\":[");
	for (uint32_t i = 0; i < ci->dependencyCount; i++) {
		const VkSubpassDependency2 *x = &ci->pDependencies[i];
		jb_printf(&j, "%s{\"srcSubpass\":%u,\"dstSubpass\":%u,\"srcStageMask\":%u,\"dstStageMask\":%u,\"srcAccessMask\":%u,"
			      "\"dstAccessMask\":%u,\"dependencyFlags\":%u,\"viewOffset\":%d}",
			  i ? "," : "", x->srcSubpass, x->dstSubpass, x->srcStageMask, x->dstStageMask, x->srcAccessMask,
			  x->dstAccessMask, x->dependencyFlags, x->viewOffset);
	}
	JS(&j, "],\"correlatedViewMasks\":");
	j_u32s(&j, ci->pCorrelatedViewMasks, ci->correlatedViewMaskCount);
	JS(&j, "}");
	send_msg(d, &j, NULL, 0);
	*out = (VkRenderPass)(uintptr_t)o;
	return VK_SUCCESS;
}

static API void CALL kw_vkCmdBeginRenderPass2(VkCommandBuffer c, const VkRenderPassBeginInfo *rp, const VkSubpassBeginInfo *sb)
{
	kw_vkCmdBeginRenderPass(c, rp, sb->contents);
}
static API void CALL kw_vkCmdNextSubpass2(VkCommandBuffer c, const VkSubpassBeginInfo *sb, const VkSubpassEndInfo *se)
{
	(void)se;
	kw_vkCmdNextSubpass(c, sb->contents);
}
static API void CALL kw_vkCmdEndRenderPass2(VkCommandBuffer c, const VkSubpassEndInfo *se)
{
	(void)se;
	kw_vkCmdEndRenderPass(c);
}

/* ---- dynamic rendering ---- */

static void j_rattach(struct jb *b, const VkRenderingAttachmentInfo *a)
{
	jb_printf(b, "{\"imageView\":%u,\"imageLayout\":%u,\"resolveMode\":%u,\"resolveImageView\":%u,\"resolveImageLayout\":%u,"
		     "\"loadOp\":%u,\"storeOp\":%u,\"clearValue\":",
		  OID(a->imageView), a->imageLayout, a->resolveMode, OID(a->resolveImageView), a->resolveImageLayout, a->loadOp, a->storeOp);
	j_cvalue(b, &a->clearValue);
	JS(b, "}");
}

static API void CALL kw_vkCmdBeginRendering(VkCommandBuffer c, const VkRenderingInfo *ri)
{
	struct jb *b = cmd(c, "vkCmdBeginRendering");
	jb_printf(b, ",\"flags\":%u,\"renderArea\":", ri->flags);
	j_rect(b, ri->renderArea);
	jb_printf(b, ",\"layerCount\":%u,\"viewMask\":%u,\"colorAttachments\":[", ri->layerCount, ri->viewMask);
	for (uint32_t i = 0; i < ri->colorAttachmentCount; i++) {
		if (i)
			JS(b, ",");
		j_rattach(b, &ri->pColorAttachments[i]);
	}
	JS(b, "]");
	if (ri->pDepthAttachment) {
		JS(b, ",\"depthAttachment\":");
		j_rattach(b, ri->pDepthAttachment);
	}
	if (ri->pStencilAttachment) {
		JS(b, ",\"stencilAttachment\":");
		j_rattach(b, ri->pStencilAttachment);
	}
	JS(b, "}");
}
static API void CALL kw_vkCmdEndRendering(VkCommandBuffer c) { JS(cmd(c, "vkCmdEndRendering"), "}"); }

/* ---- extended dynamic state ---- */

static API void CALL kw_vkCmdSetCullMode(VkCommandBuffer c, VkCullModeFlags m) { jb_printf(cmd(c, "vkCmdSetCullMode"), ",\"cullMode\":%u}", m); }
static API void CALL kw_vkCmdSetFrontFace(VkCommandBuffer c, VkFrontFace f) { jb_printf(cmd(c, "vkCmdSetFrontFace"), ",\"frontFace\":%u}", f); }
static API void CALL kw_vkCmdSetPrimitiveTopology(VkCommandBuffer c, VkPrimitiveTopology t)
{
	jb_printf(cmd(c, "vkCmdSetPrimitiveTopology"), ",\"primitiveTopology\":%u}", t);
}
static API void CALL kw_vkCmdSetDepthTestEnable(VkCommandBuffer c, VkBool32 e) { jb_printf(cmd(c, "vkCmdSetDepthTestEnable"), ",\"depthTestEnable\":%u}", e); }
static API void CALL kw_vkCmdSetDepthWriteEnable(VkCommandBuffer c, VkBool32 e) { jb_printf(cmd(c, "vkCmdSetDepthWriteEnable"), ",\"depthWriteEnable\":%u}", e); }
static API void CALL kw_vkCmdSetDepthCompareOp(VkCommandBuffer c, VkCompareOp o) { jb_printf(cmd(c, "vkCmdSetDepthCompareOp"), ",\"depthCompareOp\":%u}", o); }
static API void CALL kw_vkCmdSetDepthBoundsTestEnable(VkCommandBuffer c, VkBool32 e)
{
	jb_printf(cmd(c, "vkCmdSetDepthBoundsTestEnable"), ",\"depthBoundsTestEnable\":%u}", e);
}
static API void CALL kw_vkCmdSetStencilTestEnable(VkCommandBuffer c, VkBool32 e) { jb_printf(cmd(c, "vkCmdSetStencilTestEnable"), ",\"stencilTestEnable\":%u}", e); }
static API void CALL kw_vkCmdSetStencilOp(VkCommandBuffer c, VkStencilFaceFlags f, VkStencilOp fail, VkStencilOp pass, VkStencilOp dfail, VkCompareOp cmp)
{
	jb_printf(cmd(c, "vkCmdSetStencilOp"), ",\"faceMask\":%u,\"failOp\":%u,\"passOp\":%u,\"depthFailOp\":%u,\"compareOp\":%u}", f, fail, pass, dfail, cmp);
}
static API void CALL kw_vkCmdSetViewportWithCount(VkCommandBuffer c, uint32_t n, const VkViewport *v)
{
	struct jb *b = cmd(c, "vkCmdSetViewportWithCount");
	JS(b, ",\"viewports\":[");
	for (uint32_t i = 0; i < n; i++) {
		if (i)
			JS(b, ",");
		j_viewport(b, &v[i]);
	}
	JS(b, "]}");
}
static API void CALL kw_vkCmdSetScissorWithCount(VkCommandBuffer c, uint32_t n, const VkRect2D *r)
{
	struct jb *b = cmd(c, "vkCmdSetScissorWithCount");
	JS(b, ",\"scissors\":[");
	for (uint32_t i = 0; i < n; i++) {
		if (i)
			JS(b, ",");
		j_rect(b, r[i]);
	}
	JS(b, "]}");
}
static API void CALL kw_vkCmdBindVertexBuffers2(VkCommandBuffer c, uint32_t first, uint32_t n, const VkBuffer *bufs, const VkDeviceSize *offs,
	const VkDeviceSize *sizes, const VkDeviceSize *strides)
{
	struct jb *b = cmd(c, "vkCmdBindVertexBuffers2");
	for (uint32_t i = 0; i < n; i++)
		cb_read_range(CB(c), HANDLE(struct kw_buffer, bufs[i]), offs[i],
			      sizes && sizes[i] != VK_WHOLE_SIZE && sizes[i] <= KW_WHOLE - offs[i] ? offs[i] + sizes[i] : KW_WHOLE);
	jb_printf(b, ",\"firstBinding\":%u,\"buffers\":[", first);
	for (uint32_t i = 0; i < n; i++)
		jb_printf(b, i ? ",%u" : "%u", BUFID(bufs[i]));
	JS(b, "],\"offsets\":[");
	for (uint32_t i = 0; i < n; i++)
		jb_printf(b, i ? ",%llu" : "%llu", (unsigned long long)offs[i]);
	JS(b, "]");
	if (sizes) {
		JS(b, ",\"sizes\":[");
		for (uint32_t i = 0; i < n; i++) {
			if (i)
				JS(b, ",");
			j_size(b, sizes[i]);
		}
		JS(b, "]");
	}
	if (strides) {
		JS(b, ",\"strides\":[");
		for (uint32_t i = 0; i < n; i++)
			jb_printf(b, i ? ",%llu" : "%llu", (unsigned long long)strides[i]);
		JS(b, "]");
	}
	JS(b, "}");
}

/* ---- dispatch ---- */

static API PFN_vkVoidFunction CALL kw_vkGetDeviceProcAddr(VkDevice d, const char *name);
static API PFN_vkVoidFunction CALL kw_vkGetInstanceProcAddr(VkInstance i, const char *name);

#define E(n) {#n, (PFN_vkVoidFunction)kw_##n}
static const struct {
	const char *name;
	PFN_vkVoidFunction fn;
} procs[] = {
	E(vkCreateInstance), E(vkDestroyInstance), E(vkEnumerateInstanceExtensionProperties), E(vkEnumeratePhysicalDevices),
	E(vkGetInstanceProcAddr), E(vkGetDeviceProcAddr),
	E(vkGetPhysicalDeviceProperties), E(vkGetPhysicalDeviceFeatures), E(vkGetPhysicalDeviceMemoryProperties),
	E(vkGetPhysicalDeviceQueueFamilyProperties), E(vkGetPhysicalDeviceFormatProperties),
	E(vkGetPhysicalDeviceImageFormatProperties), E(vkGetPhysicalDeviceSparseImageFormatProperties),
	E(vkEnumerateDeviceExtensionProperties), E(vkEnumerateDeviceLayerProperties),
	E(vkGetPhysicalDeviceFeatures2), E(vkGetPhysicalDeviceProperties2), E(vkGetPhysicalDeviceMemoryProperties2),
	E(vkGetPhysicalDeviceFormatProperties2), E(vkGetPhysicalDeviceImageFormatProperties2),
	E(vkGetPhysicalDeviceQueueFamilyProperties2), E(vkGetPhysicalDeviceSparseImageFormatProperties2),
	E(vkCreateDevice), E(vkDestroyDevice), E(vkGetDeviceQueue),
	E(vkAllocateMemory), E(vkFreeMemory), E(vkMapMemory), E(vkUnmapMemory), E(vkFlushMappedMemoryRanges),
	E(vkInvalidateMappedMemoryRanges), E(vkGetDeviceMemoryCommitment),
	E(vkCreateBuffer), E(vkDestroyBuffer), E(vkGetBufferMemoryRequirements), E(vkBindBufferMemory),
	E(vkCreateImage), E(vkDestroyImage), E(vkGetImageMemoryRequirements), E(vkBindImageMemory),
	E(vkGetImageSubresourceLayout), E(vkGetImageSparseMemoryRequirements),
	E(vkCreateImageView), E(vkDestroyImageView), E(vkCreateBufferView), E(vkDestroyBufferView),
	E(vkCreateSampler), E(vkDestroySampler), E(vkCreateShaderModule), E(vkDestroyShaderModule),
	E(vkCreateDescriptorSetLayout), E(vkDestroyDescriptorSetLayout), E(vkCreatePipelineLayout), E(vkDestroyPipelineLayout),
	E(vkCreateRenderPass), E(vkDestroyRenderPass), E(vkGetRenderAreaGranularity),
	E(vkCreateFramebuffer), E(vkDestroyFramebuffer),
	E(vkCreateGraphicsPipelines), E(vkCreateComputePipelines), E(vkDestroyPipeline),
	E(vkCreatePipelineCache), E(vkDestroyPipelineCache), E(vkGetPipelineCacheData), E(vkMergePipelineCaches),
	E(vkCreateDescriptorPool), E(vkDestroyDescriptorPool), E(vkResetDescriptorPool),
	E(vkAllocateDescriptorSets), E(vkFreeDescriptorSets), E(vkUpdateDescriptorSets),
	E(vkCreateFence), E(vkDestroyFence), E(vkResetFences), E(vkGetFenceStatus), E(vkWaitForFences),
	E(vkCreateSemaphore), E(vkDestroySemaphore),
	E(vkCreateEvent), E(vkDestroyEvent), E(vkGetEventStatus), E(vkSetEvent), E(vkResetEvent),
	E(vkCreateQueryPool), E(vkDestroyQueryPool), E(vkGetQueryPoolResults), E(vkResetQueryPool),
	E(vkCreateCommandPool), E(vkDestroyCommandPool), E(vkResetCommandPool),
	E(vkAllocateCommandBuffers), E(vkFreeCommandBuffers),
	E(vkBeginCommandBuffer), E(vkEndCommandBuffer), E(vkResetCommandBuffer),
	E(vkCmdBeginRenderPass), E(vkCmdNextSubpass), E(vkCmdEndRenderPass), E(vkCmdBindPipeline),
	E(vkCmdBindDescriptorSets), E(vkCmdBindVertexBuffers), E(vkCmdBindIndexBuffer),
	E(vkCmdSetViewport), E(vkCmdSetScissor), E(vkCmdSetLineWidth), E(vkCmdSetDepthBias), E(vkCmdSetBlendConstants),
	E(vkCmdSetDepthBounds), E(vkCmdSetStencilCompareMask), E(vkCmdSetStencilWriteMask), E(vkCmdSetStencilReference),
	E(vkCmdDraw), E(vkCmdDrawIndexed), E(vkCmdDrawIndirect), E(vkCmdDrawIndexedIndirect),
	E(vkCmdDispatch), E(vkCmdDispatchIndirect),
	E(vkCmdCopyBuffer), E(vkCmdCopyImage), E(vkCmdBlitImage), E(vkCmdCopyBufferToImage), E(vkCmdCopyImageToBuffer),
	E(vkCmdUpdateBuffer), E(vkCmdFillBuffer), E(vkCmdClearColorImage), E(vkCmdClearDepthStencilImage),
	E(vkCmdClearAttachments), E(vkCmdResolveImage), E(vkCmdPushConstants), E(vkCmdExecuteCommands),
	E(vkCmdPipelineBarrier), E(vkCmdSetEvent), E(vkCmdResetEvent), E(vkCmdWaitEvents),
	E(vkCmdBeginQuery), E(vkCmdEndQuery), E(vkCmdResetQueryPool), E(vkCmdWriteTimestamp), E(vkCmdCopyQueryPoolResults),
	E(vkQueueSubmit), E(vkQueueWaitIdle), E(vkDeviceWaitIdle), E(vkQueueBindSparse),
	E(vkGetBufferMemoryRequirements2), E(vkGetImageMemoryRequirements2), E(vkGetImageSparseMemoryRequirements2),
	E(vkBindBufferMemory2), E(vkBindImageMemory2), E(vkGetDeviceQueue2), E(vkTrimCommandPool),
	E(vkEnumerateInstanceVersion), E(vkEnumeratePhysicalDeviceGroups), E(vkGetPhysicalDeviceExternalBufferProperties),
	E(vkGetPhysicalDeviceExternalFenceProperties), E(vkGetPhysicalDeviceExternalSemaphoreProperties),
	E(vkGetDeviceGroupPeerMemoryFeatures), E(vkCmdSetDeviceMask), E(vkCmdDispatchBase), E(vkGetDescriptorSetLayoutSupport),
	E(vkCreateSamplerYcbcrConversion), E(vkDestroySamplerYcbcrConversion),
	E(vkCreateDescriptorUpdateTemplate), E(vkDestroyDescriptorUpdateTemplate), E(vkUpdateDescriptorSetWithTemplate),
	E(vkCreateRenderPass2), E(vkCmdBeginRenderPass2), E(vkCmdNextSubpass2), E(vkCmdEndRenderPass2),
	E(vkCmdBeginRendering), E(vkCmdEndRendering),
	E(vkGetSemaphoreCounterValue), E(vkWaitSemaphores), E(vkSignalSemaphore), E(vkGetBufferDeviceAddress),
	E(vkGetBufferOpaqueCaptureAddress), E(vkGetDeviceMemoryOpaqueCaptureAddress), E(vkCmdDrawIndirectCount),
	E(vkCmdDrawIndexedIndirectCount),
	E(vkCmdSetCullMode), E(vkCmdSetFrontFace), E(vkCmdSetPrimitiveTopology), E(vkCmdSetDepthTestEnable),
	E(vkCmdSetDepthWriteEnable), E(vkCmdSetDepthCompareOp), E(vkCmdSetDepthBoundsTestEnable), E(vkCmdSetStencilTestEnable),
	E(vkCmdSetStencilOp), E(vkCmdSetViewportWithCount), E(vkCmdSetScissorWithCount), E(vkCmdBindVertexBuffers2),
};

static PFN_vkVoidFunction lookup(const char *name)
{
	if (!name)
		return NULL;
	for (size_t i = 0; i < sizeof procs / sizeof *procs; i++)
		if (!strcmp(procs[i].name, name))
			return procs[i].fn;
	PFN_vkVoidFunction f = kw_wsi_proc(name);
	if (f)
		return f;
	/* promoted extension functions: vkFooKHR / vkFooEXT -> vkFoo */
	size_t n = strlen(name);
	if (n > 5 && n < 128 && (!strcmp(name + n - 3, "KHR") || !strcmp(name + n - 3, "EXT"))) {
		char core[128];
		memcpy(core, name, n - 3);
		core[n - 3] = 0;
		for (size_t i = 0; i < sizeof procs / sizeof *procs; i++)
			if (!strcmp(procs[i].name, core))
				return procs[i].fn;
	}
	return NULL;
}

static API PFN_vkVoidFunction CALL kw_vkGetDeviceProcAddr(VkDevice d, const char *name)
{
	(void)d;
	return lookup(name);
}

static API PFN_vkVoidFunction CALL kw_vkGetInstanceProcAddr(VkInstance i, const char *name)
{
	if (!i && name && strcmp(name, "vkCreateInstance") && strcmp(name, "vkEnumerateInstanceExtensionProperties") &&
	    strcmp(name, "vkGetInstanceProcAddr") &&
	    strcmp(name, "vkEnumerateInstanceVersion"))
		return NULL;
	return lookup(name);
}

KW_EXPORT VKAPI_ATTR VkResult VKAPI_CALL vk_icdNegotiateLoaderICDInterfaceVersion(uint32_t *v)
{
	if (*v < 2)
		return VK_ERROR_INCOMPATIBLE_DRIVER;
	if (*v > 5)
		*v = 5;
	return VK_SUCCESS;
}

KW_EXPORT VKAPI_ATTR PFN_vkVoidFunction VKAPI_CALL vk_icdGetInstanceProcAddr(VkInstance i, const char *name)
{
	return kw_vkGetInstanceProcAddr(i, name);
}

KW_EXPORT VKAPI_ATTR PFN_vkVoidFunction VKAPI_CALL vk_icdGetPhysicalDeviceProcAddr(VkInstance i, const char *name)
{
	(void)i;
	if (!name || strncmp(name, "vkGetPhysicalDevice", 19))
		return NULL;
	return lookup(name);
}
