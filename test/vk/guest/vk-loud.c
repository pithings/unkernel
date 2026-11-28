// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// kwvk loud-failure test: what the host cannot do must reach the app as a
// Vulkan error, never as a wrong result. (1) A compute shader with a barrier
// in non-uniform control flow (Tint refuses it): vkCreateComputePipelines
// returns VK_ERROR_INVALID_SHADER_NV and a null handle. (2) A 512-wide
// workgroup reducing through shared memory, on a device allowing fewer
// invocations, runs as virtual invocations: its pipeline is made and the
// sum is right; with its barriers in a function (which virtual invocations
// do not take) it is refused as in (1). (3) The device goes on: a good
// pipeline still computes. (4) A command buffer recording vkCmdDispatchBase
// with a non-zero base (WebGPU has no base workgroup): vkQueueSubmit returns
// VK_ERROR_DEVICE_LOST, and so do the waits after it. (5) On a new
// instance, a failure only the host sees at execution (vkCmdDispatchIndirect
// of a workgroup split to fit the device): the submit succeeds, its fence
// wait returns VK_ERROR_DEVICE_LOST. The reasons go to stderr ("kwvk: ...").
// Exit 0 when every result is as expected.
#include "vk-common.h"

#include "barrier_comp.h"
#include "double_comp.h"
#include "shared512_comp.h"
#include "shared512fn_comp.h"
#include "wide_comp.h"

static int fails;

static void expect(const char *what, int ok, VkResult r)
{
	printf("vk-loud: %s: %s (VkResult %d)\n", what, ok ? "ok" : "FAIL", r);
	if (!ok)
		fails++;
}

/* a compute setup: one storage buffer of n uints (1..n, mapped) at set 0 binding 0, a push constant uint */
struct comp {
	VkDescriptorSetLayout dsl;
	VkPipelineLayout pl;
	VkBuffer buf;
	VkDeviceMemory mem;
	uint32_t *p;
	VkDescriptorPool dp;
	VkDescriptorSet ds;
	VkCommandPool pool;
	VkCommandBuffer cb;
};

static void comp_init(struct ctx *c, struct comp *k, uint32_t n)
{
	VkDescriptorSetLayoutBinding b = {.binding = 0, .descriptorType = VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, .descriptorCount = 1,
		.stageFlags = VK_SHADER_STAGE_COMPUTE_BIT};
	VkDescriptorSetLayoutCreateInfo lci = {.sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO, .bindingCount = 1, .pBindings = &b};
	CHECK(vkCreateDescriptorSetLayout(c->dev, &lci, NULL, &k->dsl));
	VkPushConstantRange pcr = {VK_SHADER_STAGE_COMPUTE_BIT, 0, 4};
	VkPipelineLayoutCreateInfo plci = {.sType = VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO, .setLayoutCount = 1, .pSetLayouts = &k->dsl,
		.pushConstantRangeCount = 1, .pPushConstantRanges = &pcr};
	CHECK(vkCreatePipelineLayout(c->dev, &plci, NULL, &k->pl));
	host_buffer(c, n * 4, VK_BUFFER_USAGE_STORAGE_BUFFER_BIT | VK_BUFFER_USAGE_INDIRECT_BUFFER_BIT, &k->buf, &k->mem);
	CHECK(vkMapMemory(c->dev, k->mem, 0, VK_WHOLE_SIZE, 0, (void **)&k->p));
	for (uint32_t i = 0; i < n; i++)
		k->p[i] = i + 1;
	VkDescriptorPoolSize ps = {VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, 1};
	VkDescriptorPoolCreateInfo dpci = {.sType = VK_STRUCTURE_TYPE_DESCRIPTOR_POOL_CREATE_INFO, .maxSets = 1, .poolSizeCount = 1, .pPoolSizes = &ps};
	CHECK(vkCreateDescriptorPool(c->dev, &dpci, NULL, &k->dp));
	VkDescriptorSetAllocateInfo dsai = {.sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_ALLOCATE_INFO, .descriptorPool = k->dp,
		.descriptorSetCount = 1, .pSetLayouts = &k->dsl};
	CHECK(vkAllocateDescriptorSets(c->dev, &dsai, &k->ds));
	VkDescriptorBufferInfo bi = {k->buf, 0, VK_WHOLE_SIZE};
	VkWriteDescriptorSet w = {.sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, .dstSet = k->ds, .dstBinding = 0, .descriptorCount = 1,
		.descriptorType = VK_DESCRIPTOR_TYPE_STORAGE_BUFFER, .pBufferInfo = &bi};
	vkUpdateDescriptorSets(c->dev, 1, &w, 0, NULL);
	k->cb = begin_cmds(c, &k->pool);
}

static VkResult comp_pipeline(struct ctx *c, struct comp *k, const uint32_t *code, size_t size, VkPipeline *out)
{
	VkComputePipelineCreateInfo cpci = {.sType = VK_STRUCTURE_TYPE_COMPUTE_PIPELINE_CREATE_INFO,
		.stage = {.sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO, .stage = VK_SHADER_STAGE_COMPUTE_BIT,
			.module = shader(c, code, size), .pName = "main"},
		.layout = k->pl};
	*out = (VkPipeline)(uintptr_t)1; /* a failed creation must leave VK_NULL_HANDLE */
	VkResult r = vkCreateComputePipelines(c->dev, VK_NULL_HANDLE, 1, &cpci, NULL, out);
	vkDestroyShaderModule(c->dev, cpci.stage.module, NULL);
	return r;
}

static void comp_record(struct comp *k, VkPipeline pipe, uint32_t push)
{
	vkCmdBindPipeline(k->cb, VK_PIPELINE_BIND_POINT_COMPUTE, pipe);
	vkCmdBindDescriptorSets(k->cb, VK_PIPELINE_BIND_POINT_COMPUTE, k->pl, 0, 1, &k->ds, 0, NULL);
	vkCmdPushConstants(k->cb, k->pl, VK_SHADER_STAGE_COMPUTE_BIT, 0, 4, &push);
}

static void ctx_done(struct ctx *c, struct comp *k)
{
	vkUnmapMemory(c->dev, k->mem);
	vkDestroyCommandPool(c->dev, k->pool, NULL);
	vkDestroyDescriptorPool(c->dev, k->dp, NULL);
	vkDestroyPipelineLayout(c->dev, k->pl, NULL);
	vkDestroyDescriptorSetLayout(c->dev, k->dsl, NULL);
	vkDestroyBuffer(c->dev, k->buf, NULL);
	vkFreeMemory(c->dev, k->mem, NULL);
	vkDestroyDevice(c->dev, NULL);
	vkDestroyInstance(c->inst, NULL);
}

int main(void)
{
	struct ctx c;
	struct comp k;
	ctx_init(&c, "vk-loud");
	VkPhysicalDeviceProperties props;
	vkGetPhysicalDeviceProperties(c.pd, &props);
	enum { N = 256 };
	comp_init(&c, &k, N);

	/* (1) refused: the WGSL fails Tint's uniformity analysis */
	VkPipeline bad;
	VkResult r = comp_pipeline(&c, &k, spv_barrier_comp, sizeof spv_barrier_comp, &bad);
	expect("barrier in non-uniform control flow: vkCreateComputePipelines refuses", r == VK_ERROR_INVALID_SHADER_NV && bad == VK_NULL_HANDLE, r);

	/* (2) 512 invocations sharing memory: on a narrower device they cannot be
	 * split, and run as virtual invocations (vk/PROTOCOL.md, Amendments,
	 * "Virtual invocations"), the reduction's sum right */
	int narrow = props.limits.maxComputeWorkGroupInvocations < 512;
	{
		struct comp k2;
		comp_init(&c, &k2, 512);
		float *v = (float *)k2.p, want = 0;
		for (uint32_t i = 0; i < 512; i++)
			want += v[i] = (float)(i % 7);
		VkPipeline wide512;
		r = comp_pipeline(&c, &k2, spv_shared512_comp, sizeof spv_shared512_comp, &wide512);
		expect("512-wide workgroup with shared memory: vkCreateComputePipelines makes it", r == VK_SUCCESS && wide512 != VK_NULL_HANDLE, r);
		if (r == VK_SUCCESS) {
			comp_record(&k2, wide512, 0);
			vkCmdDispatch(k2.cb, 1, 1, 1);
			submit_wait(&c, k2.cb);
			printf("vk-loud: 512-wide reduction: %g, want %g (the device allows %u invocations)\n", v[0], want,
			       props.limits.maxComputeWorkGroupInvocations);
			expect("and its reduction through shared memory is right", v[0] == want, VK_SUCCESS);
			vkDestroyPipeline(c.dev, wide512, NULL);
		}
		vkUnmapMemory(c.dev, k2.mem);
		vkDestroyCommandPool(c.dev, k2.pool, NULL);
		vkDestroyDescriptorPool(c.dev, k2.dp, NULL);
		vkDestroyPipelineLayout(c.dev, k2.pl, NULL);
		vkDestroyDescriptorSetLayout(c.dev, k2.dsl, NULL);
		vkDestroyBuffer(c.dev, k2.buf, NULL);
		vkFreeMemory(c.dev, k2.mem, NULL);
	}
	/* refused: the same with its barriers in a function, which virtual
	 * invocations do not take */
	if (narrow) {
		r = comp_pipeline(&c, &k, spv_shared512fn_comp, sizeof spv_shared512fn_comp, &bad);
		expect("512-wide workgroup with barriers in a function: vkCreateComputePipelines refuses", r == VK_ERROR_INVALID_SHADER_NV && bad == VK_NULL_HANDLE, r);
	} else {
		printf("vk-loud: 512-wide workgroups with barriers in a function: skipped (the device allows %u invocations)\n",
		       props.limits.maxComputeWorkGroupInvocations);
	}

	/* (3) the device goes on */
	VkPipeline good;
	CHECK(comp_pipeline(&c, &k, spv_double_comp, sizeof spv_double_comp, &good));
	comp_record(&k, good, 0);
	vkCmdDispatch(k.cb, N / 64, 1, 1);
	submit_wait(&c, k.cb);
	int wrong = 0;
	for (uint32_t i = 0; i < N; i++)
		wrong += k.p[i] != 2 * (i + 1);
	expect("after the refusals a good pipeline computes", !wrong, VK_SUCCESS);

	/* (4) a non-zero dispatch base cannot run: the submit loses the device */
	PFN_vkCmdDispatchBase dispatchBase = (PFN_vkCmdDispatchBase)vkGetDeviceProcAddr(c.dev, "vkCmdDispatchBase");
	VkFenceCreateInfo fci = {.sType = VK_STRUCTURE_TYPE_FENCE_CREATE_INFO};
	VkSubmitInfo si = {.sType = VK_STRUCTURE_TYPE_SUBMIT_INFO, .commandBufferCount = 1, .pCommandBuffers = &k.cb};
	VkCommandBufferBeginInfo cbi = {.sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO};
	VkFence f;
	if (!dispatchBase) {
		expect("vkCmdDispatchBase is there", 0, VK_SUCCESS);
	} else {
		CHECK(vkBeginCommandBuffer(k.cb, &cbi));
		comp_record(&k, good, 0);
		dispatchBase(k.cb, 2, 0, 0, 2, 1, 1);
		CHECK(vkEndCommandBuffer(k.cb));
		CHECK(vkCreateFence(c.dev, &fci, NULL, &f));
		r = vkQueueSubmit(c.queue, 1, &si, f);
		expect("non-zero vkCmdDispatchBase: vkQueueSubmit loses the device", r == VK_ERROR_DEVICE_LOST, r);
		r = vkQueueWaitIdle(c.queue);
		expect("then vkQueueWaitIdle reports the loss", r == VK_ERROR_DEVICE_LOST, r);
		r = vkGetFenceStatus(c.dev, f);
		expect("and vkGetFenceStatus", r == VK_ERROR_DEVICE_LOST, r);
		vkDestroyFence(c.dev, f, NULL);
	}
	vkDestroyPipeline(c.dev, good, NULL);
	ctx_done(&c, &k);

	/* (5) a failure only the host sees, at execution: the fence wait reports the lost device */
	if (narrow) {
		ctx_init(&c, "vk-loud");
		comp_init(&c, &k, N);
		VkPipeline wide;
		CHECK(comp_pipeline(&c, &k, spv_wide_comp, sizeof spv_wide_comp, &wide));
		k.p[0] = 1, k.p[1] = 1, k.p[2] = 1; /* the indirect group counts */
		comp_record(&k, wide, N);
		vkCmdDispatchIndirect(k.cb, k.buf, 0);
		CHECK(vkEndCommandBuffer(k.cb));
		CHECK(vkCreateFence(c.dev, &fci, NULL, &f));
		r = vkQueueSubmit(c.queue, 1, &si, f);
		expect("dispatch the host cannot run: vkQueueSubmit itself succeeds", r == VK_SUCCESS, r);
		r = vkWaitForFences(c.dev, 1, &f, VK_TRUE, UINT64_MAX);
		expect("and its fence wait reports the lost device", r == VK_ERROR_DEVICE_LOST, r);
		r = vkQueueSubmit(c.queue, 1, &si, VK_NULL_HANDLE);
		expect("as does the next submit", r == VK_ERROR_DEVICE_LOST, r);
		vkDestroyFence(c.dev, f, NULL);
		vkDestroyPipeline(c.dev, wide, NULL);
		ctx_done(&c, &k);
	}

	printf("vk-loud: %s\n", fails ? "FAIL" : "ok");
	return fails ? 1 : 0;
}
