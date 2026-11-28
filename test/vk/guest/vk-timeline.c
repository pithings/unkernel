// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// kwvk timeline semaphore test (Vulkan 1.2 timelineSemaphore). (1) The
// feature, its properties and VK_KHR_timeline_semaphore are reported, and
// a device takes the feature. (2) A value signalled by a submit that writes
// no host-visible memory is reached at the submit: vkGetSemaphoreCounterValue
// and vkWaitSemaphores answer without a round trip (no sync request in the
// ICD's KWVK_TRACE). (3) A value signalled by a submit that writes mapped
// memory is reached at its reply, and the wait reads that memory back.
// (4) Wait before signal: a submit waiting for a value nothing has
// signalled is held, with the submit after it, until vkSignalSemaphore
// from another thread; then both run in order (their writes to one buffer:
// the later one's stays), and the fence and values follow. (5) Held
// submits released by an earlier held submit's signal; a vkQueueSubmit
// whose first batch goes and second waits; vkQueueWaitIdle waits for the
// release. (6) Wait any and all, timeouts, a host wait released by a host
// signal on another thread. (7) Device loss (a dispatch only the host
// cannot run, on a device narrower than 512 invocations): waits, counter
// queries and a held submit's fence report VK_ERROR_DEVICE_LOST instead of
// hanging. (8) Not about timelines: the inter-stage limit is WebGPU's
// locations for any app, one more for wgpu-hal (which subtracts one for the
// position). Exit 0 when every result is as expected.
#include <pthread.h>
#include <time.h>
#include <unistd.h>

#include "vk-common.h"

#include "wide_comp.h"

static int fails;
static const char *trace_path = "/tmp/vk-timeline.trace";

static void expect(const char *what, int ok, VkResult r)
{
	printf("vk-timeline: %s: %s (VkResult %d)\n", what, ok ? "ok" : "FAIL", r);
	if (!ok)
		fails++;
}

static int64_t now_ms(void)
{
	struct timespec t;
	clock_gettime(CLOCK_MONOTONIC, &t);
	return (int64_t)t.tv_sec * 1000 + t.tv_nsec / 1000000;
}

/* messages of one op the ICD sent so far (KWVK_TRACE logs every one) */
static int traced(const char *op)
{
	FILE *f = fopen(trace_path, "r");
	if (!f)
		return -1;
	char pat[64], line[1 << 16];
	snprintf(pat, sizeof pat, "\"op\":\"%s\"", op);
	int n = 0;
	while (fgets(line, sizeof line, f))
		n += strstr(line, pat) != NULL;
	fclose(f);
	return n;
}

static struct ctx c;

static void init(const char *name)
{
	VkApplicationInfo app = {.sType = VK_STRUCTURE_TYPE_APPLICATION_INFO, .pApplicationName = name, .apiVersion = VK_API_VERSION_1_2};
	VkInstanceCreateInfo ici = {.sType = VK_STRUCTURE_TYPE_INSTANCE_CREATE_INFO, .pApplicationInfo = &app};
	CHECK(vkCreateInstance(&ici, NULL, &c.inst));
	uint32_t n = 1;
	VkResult r = vkEnumeratePhysicalDevices(c.inst, &n, &c.pd);
	if ((r != VK_SUCCESS && r != VK_INCOMPLETE) || !n) {
		fprintf(stderr, "no physical device\n");
		exit(1);
	}
	vkGetPhysicalDeviceMemoryProperties(c.pd, &c.mem);
	VkPhysicalDeviceVulkan12Features f12 = {.sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_VULKAN_1_2_FEATURES, .timelineSemaphore = VK_TRUE};
	float prio = 1;
	VkDeviceQueueCreateInfo q = {.sType = VK_STRUCTURE_TYPE_DEVICE_QUEUE_CREATE_INFO, .queueCount = 1, .pQueuePriorities = &prio};
	VkDeviceCreateInfo dci = {.sType = VK_STRUCTURE_TYPE_DEVICE_CREATE_INFO, .pNext = &f12, .queueCreateInfoCount = 1, .pQueueCreateInfos = &q};
	CHECK(vkCreateDevice(c.pd, &dci, NULL, &c.dev));
	vkGetDeviceQueue(c.dev, 0, 0, &c.queue);
}

static void done(void)
{
	vkDestroyDevice(c.dev, NULL);
	vkDestroyInstance(c.inst, NULL);
}

static VkSemaphore timeline(uint64_t initial)
{
	VkSemaphoreTypeCreateInfo t = {.sType = VK_STRUCTURE_TYPE_SEMAPHORE_TYPE_CREATE_INFO, .semaphoreType = VK_SEMAPHORE_TYPE_TIMELINE,
		.initialValue = initial};
	VkSemaphoreCreateInfo ci = {.sType = VK_STRUCTURE_TYPE_SEMAPHORE_CREATE_INFO, .pNext = &t};
	VkSemaphore s;
	CHECK(vkCreateSemaphore(c.dev, &ci, NULL, &s));
	return s;
}

static uint64_t counter(VkSemaphore s)
{
	uint64_t v = ~0ull;
	CHECK(vkGetSemaphoreCounterValue(c.dev, s, &v));
	return v;
}

static VkResult wait1(VkSemaphore s, uint64_t v, uint64_t timeout_ns)
{
	VkSemaphoreWaitInfo wi = {.sType = VK_STRUCTURE_TYPE_SEMAPHORE_WAIT_INFO, .semaphoreCount = 1, .pSemaphores = &s, .pValues = &v};
	return vkWaitSemaphores(c.dev, &wi, timeout_ns);
}

static VkCommandPool pool;

/* a recorded command buffer that fills [0, size) of buf with word */
static VkCommandBuffer fill_cmds(VkBuffer buf, VkDeviceSize size, uint32_t word)
{
	VkCommandBufferAllocateInfo ai = {.sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_ALLOCATE_INFO, .commandPool = pool,
		.level = VK_COMMAND_BUFFER_LEVEL_PRIMARY, .commandBufferCount = 1};
	VkCommandBuffer cb;
	CHECK(vkAllocateCommandBuffers(c.dev, &ai, &cb));
	VkCommandBufferBeginInfo bi = {.sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO};
	CHECK(vkBeginCommandBuffer(cb, &bi));
	vkCmdFillBuffer(cb, buf, 0, size, word);
	CHECK(vkEndCommandBuffer(cb));
	return cb;
}

/* one batch: command buffer cb (may be NULL), waiting for (ws, wv) and signalling (ss, sv) when given */
struct batch {
	VkSubmitInfo si;
	VkTimelineSemaphoreSubmitInfo t;
	VkSemaphore ws, ss;
	uint64_t wv, sv;
	VkPipelineStageFlags stage;
	VkCommandBuffer cb;
};
static void batch(struct batch *b, VkCommandBuffer cb, VkSemaphore ws, uint64_t wv, VkSemaphore ss, uint64_t sv)
{
	memset(b, 0, sizeof *b);
	b->ws = ws, b->wv = wv, b->ss = ss, b->sv = sv, b->cb = cb;
	b->stage = VK_PIPELINE_STAGE_ALL_COMMANDS_BIT;
	b->t = (VkTimelineSemaphoreSubmitInfo){.sType = VK_STRUCTURE_TYPE_TIMELINE_SEMAPHORE_SUBMIT_INFO,
		.waitSemaphoreValueCount = ws ? 1 : 0, .pWaitSemaphoreValues = &b->wv,
		.signalSemaphoreValueCount = ss ? 1 : 0, .pSignalSemaphoreValues = &b->sv};
	b->si = (VkSubmitInfo){.sType = VK_STRUCTURE_TYPE_SUBMIT_INFO, .pNext = &b->t,
		.waitSemaphoreCount = ws ? 1 : 0, .pWaitSemaphores = &b->ws, .pWaitDstStageMask = &b->stage,
		.commandBufferCount = cb ? 1 : 0, .pCommandBuffers = &b->cb,
		.signalSemaphoreCount = ss ? 1 : 0, .pSignalSemaphores = &b->ss};
}
static VkResult submit1(VkCommandBuffer cb, VkSemaphore ws, uint64_t wv, VkSemaphore ss, uint64_t sv, VkFence f)
{
	struct batch b;
	batch(&b, cb, ws, wv, ss, sv);
	return vkQueueSubmit(c.queue, 1, &b.si, f);
}

/* buffers: one in device-only memory (its fills write nothing the app can map), one mapped */
static void buffer(VkDeviceSize size, VkMemoryPropertyFlags want, VkBufferUsageFlags usage, VkBuffer *buf, VkDeviceMemory *mem)
{
	VkBufferCreateInfo bci = {.sType = VK_STRUCTURE_TYPE_BUFFER_CREATE_INFO, .size = size, .usage = usage};
	CHECK(vkCreateBuffer(c.dev, &bci, NULL, buf));
	VkMemoryRequirements req;
	vkGetBufferMemoryRequirements(c.dev, *buf, &req);
	VkMemoryAllocateInfo ai = {.sType = VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO, .allocationSize = req.size,
		.memoryTypeIndex = mem_type(&c, req.memoryTypeBits, want)};
	CHECK(vkAllocateMemory(c.dev, &ai, NULL, mem));
	CHECK(vkBindBufferMemory(c.dev, *buf, *mem, 0));
}

struct later {
	VkSemaphore sem;
	uint64_t value;
	int ms;
	VkResult r;
	int64_t at;
};
/* another thread: after ms, vkSignalSemaphore(sem, value) */
static void *signal_later(void *arg)
{
	struct later *l = arg;
	usleep(l->ms * 1000);
	l->at = now_ms();
	VkSemaphoreSignalInfo si = {.sType = VK_STRUCTURE_TYPE_SEMAPHORE_SIGNAL_INFO, .semaphore = l->sem, .value = l->value};
	l->r = vkSignalSemaphore(c.dev, &si);
	return NULL;
}
/* another thread: vkWaitSemaphores(sem, value) without a timeout */
static void *wait_forever(void *arg)
{
	struct later *l = arg;
	l->r = wait1(l->sem, l->value, UINT64_MAX);
	l->at = now_ms();
	return NULL;
}

static void features(void)
{
	VkPhysicalDeviceTimelineSemaphoreFeatures tf = {.sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_TIMELINE_SEMAPHORE_FEATURES};
	VkPhysicalDeviceVulkan12Features f12 = {.sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_VULKAN_1_2_FEATURES, .pNext = &tf};
	VkPhysicalDeviceFeatures2 f2 = {.sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_FEATURES_2, .pNext = &f12};
	vkGetPhysicalDeviceFeatures2(c.pd, &f2);
	VkPhysicalDeviceTimelineSemaphoreProperties tp = {.sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_TIMELINE_SEMAPHORE_PROPERTIES};
	VkPhysicalDeviceVulkan12Properties p12 = {.sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_VULKAN_1_2_PROPERTIES, .pNext = &tp};
	VkPhysicalDeviceProperties2 p2 = {.sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_PROPERTIES_2, .pNext = &p12};
	vkGetPhysicalDeviceProperties2(c.pd, &p2);
	uint32_t n = 0;
	CHECK(vkEnumerateDeviceExtensionProperties(c.pd, NULL, &n, NULL));
	VkExtensionProperties *ext = calloc(n, sizeof *ext);
	CHECK(vkEnumerateDeviceExtensionProperties(c.pd, NULL, &n, ext));
	int has = 0;
	for (uint32_t i = 0; i < n; i++)
		has |= !strcmp(ext[i].extensionName, VK_KHR_TIMELINE_SEMAPHORE_EXTENSION_NAME);
	free(ext);
	printf("vk-timeline: maxTimelineSemaphoreValueDifference %llu (1.2 properties %llu)\n",
	       (unsigned long long)tp.maxTimelineSemaphoreValueDifference, (unsigned long long)p12.maxTimelineSemaphoreValueDifference);
	expect("timelineSemaphore reported (Vulkan12Features, TimelineSemaphoreFeatures), VK_KHR_timeline_semaphore listed",
	       f12.timelineSemaphore && tf.timelineSemaphore && has, VK_SUCCESS);
	expect("maxTimelineSemaphoreValueDifference at least 2^31 - 1",
	       tp.maxTimelineSemaphoreValueDifference >= 0x7fffffffull && p12.maxTimelineSemaphoreValueDifference == tp.maxTimelineSemaphoreValueDifference,
	       VK_SUCCESS);
}

/* maxVertexOutputComponents of a new instance whose engine is `engine` */
static uint32_t out_components(const char *engine)
{
	VkApplicationInfo app = {.sType = VK_STRUCTURE_TYPE_APPLICATION_INFO, .pEngineName = engine, .apiVersion = VK_API_VERSION_1_2};
	VkInstanceCreateInfo ici = {.sType = VK_STRUCTURE_TYPE_INSTANCE_CREATE_INFO, .pApplicationInfo = &app};
	VkInstance inst;
	CHECK(vkCreateInstance(&ici, NULL, &inst));
	uint32_t n = 1;
	VkPhysicalDevice pd;
	VkResult r = vkEnumeratePhysicalDevices(inst, &n, &pd);
	VkPhysicalDeviceProperties p = {0};
	if ((r == VK_SUCCESS || r == VK_INCOMPLETE) && n)
		vkGetPhysicalDeviceProperties(pd, &p);
	vkDestroyInstance(inst, NULL);
	return p.limits.maxVertexOutputComponents == p.limits.maxFragmentInputComponents ? p.limits.maxVertexOutputComponents : 0;
}

int main(void)
{
	setenv("KWVK_TRACE", trace_path, 1);
	init("vk-timeline");
	features();
	VkCommandPoolCreateInfo pci = {.sType = VK_STRUCTURE_TYPE_COMMAND_POOL_CREATE_INFO,
		.flags = VK_COMMAND_POOL_CREATE_RESET_COMMAND_BUFFER_BIT};
	CHECK(vkCreateCommandPool(c.dev, &pci, NULL, &pool));
	enum { SIZE = 4096 };
	VkBuffer dbuf, hbuf;
	VkDeviceMemory dmem, hmem;
	buffer(SIZE, VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT, VK_BUFFER_USAGE_TRANSFER_DST_BIT, &dbuf, &dmem);
	buffer(SIZE, VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT | VK_MEMORY_PROPERTY_HOST_COHERENT_BIT, VK_BUFFER_USAGE_TRANSFER_DST_BIT, &hbuf, &hmem);
	uint32_t *hp;
	CHECK(vkMapMemory(c.dev, hmem, 0, VK_WHOLE_SIZE, 0, (void **)&hp));
	VkResult r;

	/* (2) reached at the submit: no round trip per frame */
	{
		VkSemaphore s = timeline(0);
		VkCommandBuffer cb = fill_cmds(dbuf, SIZE, 7);
		int syncs = traced("sync"), reads = traced("readBuffer");
		int right = 0;
		enum { FRAMES = 20 };
		for (uint64_t i = 1; i <= FRAMES; i++) {
			CHECK(submit1(cb, VK_NULL_HANDLE, 0, s, i, VK_NULL_HANDLE));
			right += counter(s) == i;
			right += wait1(s, i, 0) == VK_SUCCESS;
		}
		int syncs2 = traced("sync"), reads2 = traced("readBuffer");
		printf("vk-timeline: %d submits each followed by a counter query and a wait: %d sync and %d readBuffer requests (trace %s)\n",
		       FRAMES, syncs2 - syncs, reads2 - reads, syncs < 0 ? "missing" : "read");
		expect("a value a submit writing no mapped memory signals is reached at the submit", right == 2 * FRAMES, VK_SUCCESS);
		expect("without a round trip", syncs >= 0 && syncs2 == syncs && reads2 == reads, VK_SUCCESS);
		CHECK(vkQueueWaitIdle(c.queue));
		vkDestroySemaphore(c.dev, s, NULL);
		vkFreeCommandBuffers(c.dev, pool, 1, &cb);
	}

	/* (3) a submit writing mapped memory: reached at its reply, the data read back by the wait */
	{
		VkSemaphore s = timeline(0);
		VkCommandBuffer cb = fill_cmds(hbuf, SIZE, 0x5a5a5a5a);
		hp[0] = hp[SIZE / 4 - 1] = 0;
		int syncs = traced("sync");
		CHECK(submit1(cb, VK_NULL_HANDLE, 0, s, 1, VK_NULL_HANDLE));
		r = wait1(s, 1, UINT64_MAX);
		printf("vk-timeline: mapped write: counter %llu, words %08x %08x, %d sync request\n", (unsigned long long)counter(s), hp[0],
		       hp[SIZE / 4 - 1], traced("sync") - syncs);
		expect("a value a submit writing mapped memory signals: the wait returns with the GPU's data read back",
		       r == VK_SUCCESS && hp[0] == 0x5a5a5a5a && hp[SIZE / 4 - 1] == 0x5a5a5a5a && counter(s) == 1, r);
		vkDestroySemaphore(c.dev, s, NULL);
		vkFreeCommandBuffers(c.dev, pool, 1, &cb);
	}

	/* (4) wait before signal, released by vkSignalSemaphore from another thread */
	{
		VkSemaphore a = timeline(0), b = timeline(0);
		VkCommandBuffer first = fill_cmds(hbuf, SIZE, 0x11111111), second = fill_cmds(hbuf, SIZE, 0x22222222);
		VkFenceCreateInfo fci = {.sType = VK_STRUCTURE_TYPE_FENCE_CREATE_INFO};
		VkFence f1, f2;
		CHECK(vkCreateFence(c.dev, &fci, NULL, &f1));
		CHECK(vkCreateFence(c.dev, &fci, NULL, &f2));
		memset(hp, 0, SIZE);
		CHECK(submit1(first, a, 1, b, 1, f1)); /* nothing signals a = 1 yet */
		CHECK(submit1(second, VK_NULL_HANDLE, 0, b, 2, f2)); /* behind it */
		usleep(100000);
		uint64_t bv = counter(b);
		VkResult fs = vkGetFenceStatus(c.dev, f1), fs2 = vkGetFenceStatus(c.dev, f2);
		r = wait1(b, 1, 10000000);
		printf("vk-timeline: held: b %llu, fences %d %d, a 10 ms wait for b = 1: %d, word %08x\n", (unsigned long long)bv, fs, fs2, r, hp[0]);
		expect("a submit waiting for an unsignalled value is held, with the submit after it", bv == 0 && fs == VK_NOT_READY &&
		       fs2 == VK_NOT_READY && r == VK_TIMEOUT && hp[0] == 0, r);
		struct later l = {a, 1, 50, VK_ERROR_UNKNOWN, 0};
		pthread_t t;
		pthread_create(&t, NULL, signal_later, &l);
		int64_t t0 = now_ms();
		r = wait1(b, 2, UINT64_MAX);
		int64_t t1 = now_ms();
		pthread_join(t, NULL);
		VkResult fr = vkWaitForFences(c.dev, 1, &f2, VK_TRUE, UINT64_MAX);
		VkResult fr1 = vkGetFenceStatus(c.dev, f1);
		printf("vk-timeline: released after %lld ms (the signal at %lld ms): b %llu, fences %d %d, word %08x\n", (long long)(t1 - t0),
		       (long long)(l.at - t0), (unsigned long long)counter(b), fr1, fr, hp[0]);
		expect("vkSignalSemaphore from another thread releases them in order (the later fill stays)",
		       l.r == VK_SUCCESS && r == VK_SUCCESS && fr == VK_SUCCESS && fr1 == VK_SUCCESS && counter(b) == 2 && hp[0] == 0x22222222 &&
		       t1 >= l.at, r);
		vkDestroyFence(c.dev, f1, NULL);
		vkDestroyFence(c.dev, f2, NULL);
		vkDestroySemaphore(c.dev, a, NULL);
		vkDestroySemaphore(c.dev, b, NULL);
		vkFreeCommandBuffers(c.dev, pool, 1, &first);
		vkFreeCommandBuffers(c.dev, pool, 1, &second);
	}

	/* (5) held submits released by an earlier one's signal; a call whose
	 * first batch goes and second waits; vkQueueWaitIdle for the release */
	{
		VkSemaphore a = timeline(0), b = timeline(0), d = timeline(0), e = timeline(0);
		VkCommandBuffer one = fill_cmds(dbuf, SIZE, 1), two = fill_cmds(hbuf, SIZE, 0x33333333);
		memset(hp, 0, SIZE);
		CHECK(submit1(one, a, 1, b, 1, VK_NULL_HANDLE)); /* held for a = 1 */
		CHECK(submit1(two, b, 1, b, 2, VK_NULL_HANDLE)); /* waits for the held one's b = 1 */
		usleep(50000);
		uint64_t held_b = counter(b);
		VkSemaphoreSignalInfo si = {.sType = VK_STRUCTURE_TYPE_SEMAPHORE_SIGNAL_INFO, .semaphore = a, .value = 1};
		CHECK(vkSignalSemaphore(c.dev, &si));
		r = wait1(b, 2, UINT64_MAX);
		printf("vk-timeline: chain: b %llu while held, then %llu, word %08x\n", (unsigned long long)held_b, (unsigned long long)counter(b), hp[0]);
		expect("a held submit waiting for an earlier held submit's value goes after it", held_b == 0 && r == VK_SUCCESS &&
		       counter(b) == 2 && hp[0] == 0x33333333, r);

		struct batch two_batches[2];
		batch(&two_batches[0], one, VK_NULL_HANDLE, 0, d, 1);
		batch(&two_batches[1], two, e, 1, d, 2);
		VkSubmitInfo sis[2] = {two_batches[0].si, two_batches[1].si};
		memset(hp, 0, SIZE);
		CHECK(vkQueueSubmit(c.queue, 2, sis, VK_NULL_HANDLE));
		r = wait1(d, 1, UINT64_MAX);
		uint64_t dv = counter(d);
		expect("of two batches, the first goes when only the second waits", r == VK_SUCCESS && dv == 1 && hp[0] == 0, r);
		struct later l = {e, 1, 50, VK_ERROR_UNKNOWN, 0};
		pthread_t t;
		pthread_create(&t, NULL, signal_later, &l);
		int64_t t0 = now_ms();
		r = vkQueueWaitIdle(c.queue);
		int64_t t1 = now_ms();
		pthread_join(t, NULL);
		printf("vk-timeline: vkQueueWaitIdle returned %d after %lld ms (the signal at %lld ms): d %llu, word %08x\n", r, (long long)(t1 - t0),
		       (long long)(l.at - t0), (unsigned long long)counter(d), hp[0]);
		expect("vkQueueWaitIdle waits for the held batch's release and its work", r == VK_SUCCESS && t1 >= l.at && counter(d) == 2 &&
		       hp[0] == 0x33333333, r);
		vkDestroySemaphore(c.dev, a, NULL);
		vkDestroySemaphore(c.dev, b, NULL);
		vkDestroySemaphore(c.dev, d, NULL);
		vkDestroySemaphore(c.dev, e, NULL);
		vkFreeCommandBuffers(c.dev, pool, 1, &one);
		vkFreeCommandBuffers(c.dev, pool, 1, &two);
	}

	/* (6) wait any and all, timeouts, host waits and signals */
	{
		VkSemaphore s[2] = {timeline(5), timeline(0)};
		uint64_t v[2] = {5, 1};
		VkSemaphoreWaitInfo wi = {.sType = VK_STRUCTURE_TYPE_SEMAPHORE_WAIT_INFO, .semaphoreCount = 2, .pSemaphores = s, .pValues = v};
		VkResult all = vkWaitSemaphores(c.dev, &wi, 1000000);
		wi.flags = VK_SEMAPHORE_WAIT_ANY_BIT;
		VkResult any = vkWaitSemaphores(c.dev, &wi, 0);
		int64_t t0 = now_ms();
		VkResult to = wait1(s[1], 1, 30000000);
		int64_t took = now_ms() - t0;
		printf("vk-timeline: all %d, any %d, a 30 ms wait %d after %lld ms\n", all, any, to, (long long)took);
		expect("wait all times out with one value missing, wait any returns", all == VK_TIMEOUT && any == VK_SUCCESS, all);
		expect("a timeout is kept", to == VK_TIMEOUT && took >= 25 && took < 2000, to);
		struct later w = {s[1], 7, 0, VK_ERROR_UNKNOWN, 0};
		pthread_t t;
		pthread_create(&t, NULL, wait_forever, &w);
		usleep(30000);
		int64_t sig_at = now_ms();
		VkSemaphoreSignalInfo si = {.sType = VK_STRUCTURE_TYPE_SEMAPHORE_SIGNAL_INFO, .semaphore = s[1], .value = 7};
		CHECK(vkSignalSemaphore(c.dev, &si));
		pthread_join(t, NULL);
		printf("vk-timeline: a host wait on another thread returned %d %lld ms after the signal; counter %llu\n", w.r, (long long)(w.at - sig_at),
		       (unsigned long long)counter(s[1]));
		expect("a host signal releases a host wait on another thread", w.r == VK_SUCCESS && counter(s[1]) == 7, w.r);
		vkDestroySemaphore(c.dev, s[0], NULL);
		vkDestroySemaphore(c.dev, s[1], NULL);
	}
	vkUnmapMemory(c.dev, hmem);
	vkDestroyBuffer(c.dev, dbuf, NULL);
	vkDestroyBuffer(c.dev, hbuf, NULL);
	vkFreeMemory(c.dev, dmem, NULL);
	vkFreeMemory(c.dev, hmem, NULL);
	vkDestroyCommandPool(c.dev, pool, NULL);
	done();

	/* (7) a device lost by a failure only the host sees (a split workgroup's
	 * indirect dispatch), with a timeline value signalled at the submit and
	 * a held submit behind it */
	init("vk-timeline");
	VkPhysicalDeviceProperties props;
	vkGetPhysicalDeviceProperties(c.pd, &props);
	if (props.limits.maxComputeWorkGroupInvocations >= 512) {
		printf("vk-timeline: device loss: skipped (the device allows %u invocations)\n", props.limits.maxComputeWorkGroupInvocations);
	} else {
		CHECK(vkCreateCommandPool(c.dev, &pci, NULL, &pool));
		VkBuffer buf;
		VkDeviceMemory mem;
		buffer(SIZE, VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT,
		       VK_BUFFER_USAGE_STORAGE_BUFFER_BIT | VK_BUFFER_USAGE_INDIRECT_BUFFER_BIT | VK_BUFFER_USAGE_TRANSFER_DST_BIT, &buf, &mem);
		VkDescriptorSetLayoutBinding lb = {.binding = 0, .descriptorType = VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, .descriptorCount = 1,
			.stageFlags = VK_SHADER_STAGE_COMPUTE_BIT};
		VkDescriptorSetLayoutCreateInfo lci = {.sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO, .bindingCount = 1, .pBindings = &lb};
		VkDescriptorSetLayout dsl;
		CHECK(vkCreateDescriptorSetLayout(c.dev, &lci, NULL, &dsl));
		VkPushConstantRange pcr = {VK_SHADER_STAGE_COMPUTE_BIT, 0, 4};
		VkPipelineLayoutCreateInfo plci = {.sType = VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO, .setLayoutCount = 1, .pSetLayouts = &dsl,
			.pushConstantRangeCount = 1, .pPushConstantRanges = &pcr};
		VkPipelineLayout pl;
		CHECK(vkCreatePipelineLayout(c.dev, &plci, NULL, &pl));
		VkDescriptorPoolSize ps = {VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, 1};
		VkDescriptorPoolCreateInfo dpci = {.sType = VK_STRUCTURE_TYPE_DESCRIPTOR_POOL_CREATE_INFO, .maxSets = 1, .poolSizeCount = 1, .pPoolSizes = &ps};
		VkDescriptorPool dp;
		CHECK(vkCreateDescriptorPool(c.dev, &dpci, NULL, &dp));
		VkDescriptorSetAllocateInfo dsai = {.sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_ALLOCATE_INFO, .descriptorPool = dp,
			.descriptorSetCount = 1, .pSetLayouts = &dsl};
		VkDescriptorSet ds;
		CHECK(vkAllocateDescriptorSets(c.dev, &dsai, &ds));
		VkDescriptorBufferInfo dbi = {buf, 0, VK_WHOLE_SIZE};
		VkWriteDescriptorSet w = {.sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, .dstSet = ds, .dstBinding = 0, .descriptorCount = 1,
			.descriptorType = VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, .pBufferInfo = &dbi};
		vkUpdateDescriptorSets(c.dev, 1, &w, 0, NULL);
		VkComputePipelineCreateInfo cpci = {.sType = VK_STRUCTURE_TYPE_COMPUTE_PIPELINE_CREATE_INFO,
			.stage = {.sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO, .stage = VK_SHADER_STAGE_COMPUTE_BIT,
				.module = shader(&c, spv_wide_comp, sizeof spv_wide_comp), .pName = "main"},
			.layout = pl};
		VkPipeline wide;
		CHECK(vkCreateComputePipelines(c.dev, VK_NULL_HANDLE, 1, &cpci, NULL, &wide));
		VkCommandBufferAllocateInfo ai = {.sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_ALLOCATE_INFO, .commandPool = pool,
			.level = VK_COMMAND_BUFFER_LEVEL_PRIMARY, .commandBufferCount = 1};
		VkCommandBuffer cb;
		CHECK(vkAllocateCommandBuffers(c.dev, &ai, &cb));
		VkCommandBufferBeginInfo bi = {.sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO};
		CHECK(vkBeginCommandBuffer(cb, &bi));
		vkCmdFillBuffer(cb, buf, 0, 12, 1); /* the indirect group counts */
		uint32_t push = 16;
		vkCmdBindPipeline(cb, VK_PIPELINE_BIND_POINT_COMPUTE, wide);
		vkCmdBindDescriptorSets(cb, VK_PIPELINE_BIND_POINT_COMPUTE, pl, 0, 1, &ds, 0, NULL);
		vkCmdPushConstants(cb, pl, VK_SHADER_STAGE_COMPUTE_BIT, 0, 4, &push);
		vkCmdDispatchIndirect(cb, buf, 0);
		CHECK(vkEndCommandBuffer(cb));
		VkSemaphore s = timeline(0), u = timeline(0);
		VkFenceCreateInfo fci = {.sType = VK_STRUCTURE_TYPE_FENCE_CREATE_INFO};
		VkFence fh;
		CHECK(vkCreateFence(c.dev, &fci, NULL, &fh));
		r = submit1(cb, VK_NULL_HANDLE, 0, s, 1, VK_NULL_HANDLE);
		expect("a submit only the host cannot run: vkQueueSubmit itself succeeds", r == VK_SUCCESS, r);
		VkResult rh = submit1(VK_NULL_HANDLE, u, 1, VK_NULL_HANDLE, 0, fh); /* held: nothing signals u */
		int64_t t0 = now_ms();
		VkResult ri = vkQueueWaitIdle(c.queue);
		VkResult rf = vkWaitForFences(c.dev, 1, &fh, VK_TRUE, UINT64_MAX);
		uint64_t sv = 0;
		VkResult rc = vkGetSemaphoreCounterValue(c.dev, s, &sv);
		VkResult rw = wait1(s, 1, UINT64_MAX), rw2 = wait1(u, 1, 0);
		VkResult rs = submit1(VK_NULL_HANDLE, VK_NULL_HANDLE, 0, s, 2, VK_NULL_HANDLE);
		printf("vk-timeline: lost: held submit %d; wait idle %d, its fence %d (%lld ms); counter %d (value %llu); waits %d %d; submit %d\n", rh, ri, rf,
		       (long long)(now_ms() - t0), rc, (unsigned long long)sv, rw, rw2, rs);
		expect("after the loss: wait-idle, the held submit's fence, the counter, waits and submits report VK_ERROR_DEVICE_LOST",
		       rh == VK_SUCCESS && ri == VK_ERROR_DEVICE_LOST && rf == VK_ERROR_DEVICE_LOST && rc == VK_ERROR_DEVICE_LOST &&
		       rw == VK_ERROR_DEVICE_LOST && rw2 == VK_ERROR_DEVICE_LOST && rs == VK_ERROR_DEVICE_LOST, ri);
		vkDestroyFence(c.dev, fh, NULL);
		vkDestroySemaphore(c.dev, s, NULL);
		vkDestroySemaphore(c.dev, u, NULL);
		vkDestroyPipeline(c.dev, wide, NULL);
		vkDestroyShaderModule(c.dev, cpci.stage.module, NULL);
		vkDestroyDescriptorPool(c.dev, dp, NULL);
		vkDestroyPipelineLayout(c.dev, pl, NULL);
		vkDestroyDescriptorSetLayout(c.dev, dsl, NULL);
		vkDestroyBuffer(c.dev, buf, NULL);
		vkFreeMemory(c.dev, mem, NULL);
		vkDestroyCommandPool(c.dev, pool, NULL);
	}
	done();
	/* (8) */
	uint32_t plain = out_components(NULL), other = out_components("vk-timeline"), wgpu = out_components("wgpu-hal");
	printf("vk-timeline: inter-stage components: %u (no engine), %u (another engine), %u (wgpu-hal)\n", plain, other, wgpu);
	expect("wgpu-hal alone gets one location more", plain && plain % 4 == 0 && other == plain && wgpu == plain + 4, VK_SUCCESS);
	unlink(trace_path);
	printf("vk-timeline: %s\n", fails ? "FAIL" : "ok");
	return fails ? 1 : 0;
}
