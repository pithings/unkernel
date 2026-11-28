// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// kwvk texel buffer test: format features for texel buffers (and a format
// refused at vkCreateBufferView), then a compute shader (texel.comp) that
// reads a uniform texel buffer (RGBA8 at an offset off the storage buffer
// alignment) through an index texel buffer (R16_UINT), writes a storage
// texel buffer (RGBA32F) and counts with image atomics (R32_UINT), all in
// host-visible memory mapped once. The set is written three ways: one
// write spilling over consecutive bindings, a copy, a descriptor update
// template. After each fence wait the results are read directly from the
// mapping (HOST_COHERENT: no invalidate), which only the device memory
// tracking of storage texel buffers brings back; bytes around the written
// view, one of them changed by the CPU while the GPU works, keep theirs.
// Exit 0 on success.
#include <math.h>

#include "vk-common.h"

#include "texel_comp.h"

#define N 200u        /* elements gathered */
#define SRC_N 256u    /* RGBA8 texels in the source view */
#define SRC_OFF 4112u /* 16 * 257: a multiple of 16, not of 256 */
#define IDX_OFF 16u
#define DST_OFF 48u
#define DST_TAIL 64u /* bytes after the view */
#define CNT_OFF 16u

struct buf {
	VkBuffer b;
	VkDeviceMemory m;
	uint8_t *p;
};

static void mkbuf(struct ctx *c, struct buf *b, VkDeviceSize size, VkBufferUsageFlags usage)
{
	host_buffer(c, size, usage, &b->b, &b->m);
	CHECK(vkMapMemory(c->dev, b->m, 0, VK_WHOLE_SIZE, 0, (void **)&b->p));
	memset(b->p, 0, size);
}

static VkBufferView mkview(struct ctx *c, VkBuffer b, VkFormat f, VkDeviceSize off, VkDeviceSize range)
{
	VkBufferViewCreateInfo ci = {.sType = VK_STRUCTURE_TYPE_BUFFER_VIEW_CREATE_INFO, .buffer = b, .format = f, .offset = off, .range = range};
	VkBufferView v;
	CHECK(vkCreateBufferView(c->dev, &ci, NULL, &v));
	return v;
}

static int bad;
static void expect(const char *what, uint32_t i, double got, double want)
{
	if (fabs(got - want) <= 1e-6 * (fabs(want) > 1 ? fabs(want) : 1))
		return;
	if (bad < 8)
		fprintf(stderr, "%s[%u] = %g, want %g\n", what, i, got, want);
	bad++;
}

int main(void)
{
	struct ctx c;
	ctx_init(&c, "vk-texel");
	VkPhysicalDeviceProperties props;
	vkGetPhysicalDeviceProperties(c.pd, &props);
	printf("vk-texel: maxTexelBufferElements %u, minTexelBufferOffsetAlignment %llu\n", props.limits.maxTexelBufferElements,
	       (unsigned long long)props.limits.minTexelBufferOffsetAlignment);
	if (props.limits.maxTexelBufferElements < 65536 || props.limits.minTexelBufferOffsetAlignment > 16) {
		fprintf(stderr, "texel buffer limits\n");
		bad++;
	}
	/* format features: what the hello lists */
	struct {
		VkFormat f;
		VkFormatFeatureFlags want, not;
	} ff[] = {
		{VK_FORMAT_R8_UNORM, VK_FORMAT_FEATURE_UNIFORM_TEXEL_BUFFER_BIT | VK_FORMAT_FEATURE_STORAGE_TEXEL_BUFFER_BIT, 0},
		{VK_FORMAT_R8G8B8A8_UNORM, VK_FORMAT_FEATURE_UNIFORM_TEXEL_BUFFER_BIT | VK_FORMAT_FEATURE_STORAGE_TEXEL_BUFFER_BIT, 0},
		{VK_FORMAT_B10G11R11_UFLOAT_PACK32, VK_FORMAT_FEATURE_UNIFORM_TEXEL_BUFFER_BIT, VK_FORMAT_FEATURE_STORAGE_TEXEL_BUFFER_BIT},
		{VK_FORMAT_R32G32B32A32_SFLOAT, VK_FORMAT_FEATURE_UNIFORM_TEXEL_BUFFER_BIT | VK_FORMAT_FEATURE_STORAGE_TEXEL_BUFFER_BIT,
			VK_FORMAT_FEATURE_STORAGE_TEXEL_BUFFER_ATOMIC_BIT},
		{VK_FORMAT_R32_UINT, VK_FORMAT_FEATURE_STORAGE_TEXEL_BUFFER_BIT | VK_FORMAT_FEATURE_STORAGE_TEXEL_BUFFER_ATOMIC_BIT, 0},
		{VK_FORMAT_R8G8B8A8_SRGB, 0, VK_FORMAT_FEATURE_UNIFORM_TEXEL_BUFFER_BIT | VK_FORMAT_FEATURE_STORAGE_TEXEL_BUFFER_BIT},
	};
	for (size_t i = 0; i < sizeof ff / sizeof ff[0]; i++) {
		VkFormatProperties fp;
		vkGetPhysicalDeviceFormatProperties(c.pd, ff[i].f, &fp);
		if ((fp.bufferFeatures & ff[i].want) != ff[i].want || (fp.bufferFeatures & ff[i].not)) {
			fprintf(stderr, "format %u: bufferFeatures %#x\n", ff[i].f, fp.bufferFeatures);
			bad++;
		}
	}

	struct buf src, idx, dst, cnt;
	mkbuf(&c, &src, SRC_OFF + SRC_N * 4, VK_BUFFER_USAGE_UNIFORM_TEXEL_BUFFER_BIT);
	mkbuf(&c, &idx, IDX_OFF + N * 2, VK_BUFFER_USAGE_UNIFORM_TEXEL_BUFFER_BIT);
	mkbuf(&c, &dst, DST_OFF + N * 16 + DST_TAIL, VK_BUFFER_USAGE_STORAGE_TEXEL_BUFFER_BIT);
	mkbuf(&c, &cnt, CNT_OFF + 16, VK_BUFFER_USAGE_STORAGE_TEXEL_BUFFER_BIT);
	for (uint32_t i = 0; i < SRC_N * 4; i++)
		src.p[SRC_OFF + i] = (uint8_t)(i * 29 + 7);
	uint16_t *ix = (uint16_t *)(idx.p + IDX_OFF);
	for (uint32_t i = 0; i < N; i++)
		ix[i] = (uint16_t)((i * 7 + 3) % SRC_N);

	/* a format without texel buffer features: refused */
	{
		VkBufferViewCreateInfo ci = {.sType = VK_STRUCTURE_TYPE_BUFFER_VIEW_CREATE_INFO, .buffer = src.b, .format = VK_FORMAT_R8G8B8A8_SRGB,
			.offset = 0, .range = VK_WHOLE_SIZE};
		VkBufferView v;
		VkResult r = vkCreateBufferView(c.dev, &ci, NULL, &v);
		printf("vk-texel: R8G8B8A8_SRGB view: %d\n", r);
		if (r != VK_ERROR_FORMAT_NOT_SUPPORTED)
			bad++;
	}
	VkBufferView views[4] = {
		mkview(&c, src.b, VK_FORMAT_R8G8B8A8_UNORM, SRC_OFF, VK_WHOLE_SIZE),
		mkview(&c, idx.b, VK_FORMAT_R16_UINT, IDX_OFF, N * 2),
		mkview(&c, dst.b, VK_FORMAT_R32G32B32A32_SFLOAT, DST_OFF, N * 16),
		mkview(&c, cnt.b, VK_FORMAT_R32_UINT, CNT_OFF, 16),
	};

	VkDescriptorSetLayoutBinding lb[4] = {
		{0, VK_DESCRIPTOR_TYPE_UNIFORM_TEXEL_BUFFER, 1, VK_SHADER_STAGE_COMPUTE_BIT, NULL},
		{1, VK_DESCRIPTOR_TYPE_UNIFORM_TEXEL_BUFFER, 1, VK_SHADER_STAGE_COMPUTE_BIT, NULL},
		{2, VK_DESCRIPTOR_TYPE_STORAGE_TEXEL_BUFFER, 1, VK_SHADER_STAGE_COMPUTE_BIT, NULL},
		{3, VK_DESCRIPTOR_TYPE_STORAGE_TEXEL_BUFFER, 1, VK_SHADER_STAGE_COMPUTE_BIT, NULL},
	};
	VkDescriptorSetLayoutCreateInfo lci = {.sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO, .bindingCount = 4, .pBindings = lb};
	VkDescriptorSetLayout dsl;
	CHECK(vkCreateDescriptorSetLayout(c.dev, &lci, NULL, &dsl));
	VkPushConstantRange pcr = {VK_SHADER_STAGE_COMPUTE_BIT, 0, 4};
	VkPipelineLayoutCreateInfo plci = {.sType = VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO, .setLayoutCount = 1, .pSetLayouts = &dsl,
		.pushConstantRangeCount = 1, .pPushConstantRanges = &pcr};
	VkPipelineLayout pl;
	CHECK(vkCreatePipelineLayout(c.dev, &plci, NULL, &pl));
	VkComputePipelineCreateInfo cpci = {.sType = VK_STRUCTURE_TYPE_COMPUTE_PIPELINE_CREATE_INFO,
		.stage = {.sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO, .stage = VK_SHADER_STAGE_COMPUTE_BIT,
			.module = shader(&c, spv_texel_comp, sizeof spv_texel_comp), .pName = "main"},
		.layout = pl};
	VkPipeline pipe;
	CHECK(vkCreateComputePipelines(c.dev, VK_NULL_HANDLE, 1, &cpci, NULL, &pipe));

	VkDescriptorPoolSize ps[2] = {{VK_DESCRIPTOR_TYPE_UNIFORM_TEXEL_BUFFER, 6}, {VK_DESCRIPTOR_TYPE_STORAGE_TEXEL_BUFFER, 6}};
	VkDescriptorPoolCreateInfo dpci = {.sType = VK_STRUCTURE_TYPE_DESCRIPTOR_POOL_CREATE_INFO, .maxSets = 3, .poolSizeCount = 2, .pPoolSizes = ps};
	VkDescriptorPool dp;
	CHECK(vkCreateDescriptorPool(c.dev, &dpci, NULL, &dp));
	VkDescriptorSetLayout dsls[3] = {dsl, dsl, dsl};
	VkDescriptorSetAllocateInfo dsai = {.sType = VK_STRUCTURE_TYPE_DESCRIPTOR_SET_ALLOCATE_INFO, .descriptorPool = dp,
		.descriptorSetCount = 3, .pSetLayouts = dsls};
	VkDescriptorSet sets[3];
	CHECK(vkAllocateDescriptorSets(c.dev, &dsai, sets));

	/* set 0: two writes, each spilling from its first binding into the next */
	VkWriteDescriptorSet w[2] = {
		{.sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, .dstSet = sets[0], .dstBinding = 0, .descriptorCount = 2,
			.descriptorType = VK_DESCRIPTOR_TYPE_UNIFORM_TEXEL_BUFFER, .pTexelBufferView = &views[0]},
		{.sType = VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET, .dstSet = sets[0], .dstBinding = 2, .descriptorCount = 2,
			.descriptorType = VK_DESCRIPTOR_TYPE_STORAGE_TEXEL_BUFFER, .pTexelBufferView = &views[2]},
	};
	vkUpdateDescriptorSets(c.dev, 2, w, 0, NULL);
	/* set 1: copied, all four from binding 0 */
	VkCopyDescriptorSet cp = {.sType = VK_STRUCTURE_TYPE_COPY_DESCRIPTOR_SET, .srcSet = sets[0], .srcBinding = 0, .dstSet = sets[1],
		.dstBinding = 0, .descriptorCount = 4};
	vkUpdateDescriptorSets(c.dev, 0, NULL, 1, &cp);
	/* set 2: a template of two entries */
	VkDescriptorUpdateTemplateEntry te[2] = {
		{0, 0, 2, VK_DESCRIPTOR_TYPE_UNIFORM_TEXEL_BUFFER, 0, sizeof(VkBufferView)},
		{2, 0, 2, VK_DESCRIPTOR_TYPE_STORAGE_TEXEL_BUFFER, 2 * sizeof(VkBufferView), sizeof(VkBufferView)},
	};
	VkDescriptorUpdateTemplateCreateInfo tci = {.sType = VK_STRUCTURE_TYPE_DESCRIPTOR_UPDATE_TEMPLATE_CREATE_INFO,
		.descriptorUpdateEntryCount = 2, .pDescriptorUpdateEntries = te,
		.templateType = VK_DESCRIPTOR_UPDATE_TEMPLATE_TYPE_DESCRIPTOR_SET, .descriptorSetLayout = dsl};
	PFN_vkCreateDescriptorUpdateTemplate create_tpl = (PFN_vkCreateDescriptorUpdateTemplate)vkGetDeviceProcAddr(c.dev, "vkCreateDescriptorUpdateTemplate");
	PFN_vkUpdateDescriptorSetWithTemplate update_tpl = (PFN_vkUpdateDescriptorSetWithTemplate)vkGetDeviceProcAddr(c.dev, "vkUpdateDescriptorSetWithTemplate");
	PFN_vkDestroyDescriptorUpdateTemplate destroy_tpl = (PFN_vkDestroyDescriptorUpdateTemplate)vkGetDeviceProcAddr(c.dev, "vkDestroyDescriptorUpdateTemplate");
	if (!create_tpl || !update_tpl || !destroy_tpl) {
		fprintf(stderr, "no descriptor update templates\n");
		return 1;
	}
	VkDescriptorUpdateTemplate tpl;
	CHECK(create_tpl(c.dev, &tci, NULL, &tpl));
	update_tpl(c.dev, sets[2], tpl, views);

	VkCommandPool pool;
	VkCommandPoolCreateInfo pci = {.sType = VK_STRUCTURE_TYPE_COMMAND_POOL_CREATE_INFO, .queueFamilyIndex = 0};
	CHECK(vkCreateCommandPool(c.dev, &pci, NULL, &pool));
	VkCommandBufferAllocateInfo cai = {.sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_ALLOCATE_INFO, .commandPool = pool,
		.level = VK_COMMAND_BUFFER_LEVEL_PRIMARY, .commandBufferCount = 1};
	VkCommandBuffer cb;
	CHECK(vkAllocateCommandBuffers(c.dev, &cai, &cb));
	VkFenceCreateInfo fci = {.sType = VK_STRUCTURE_TYPE_FENCE_CREATE_INFO};
	VkFence fence;
	CHECK(vkCreateFence(c.dev, &fci, NULL, &fence));

	static const char *how[3] = {"write", "copy", "template"};
	for (uint32_t run = 0; run < 3; run++) {
		float scale = 1.5f + (float)run;
		memset(dst.p, 0xee, DST_OFF + N * 16 + DST_TAIL);
		memset(cnt.p, 0, CNT_OFF + 16);
		/* a new source texel each run: the submit flush must send it */
		src.p[SRC_OFF + 4 * ix[0]] = (uint8_t)(run * 50 + 1);
		VkCommandBufferBeginInfo bgi = {.sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO, .flags = VK_COMMAND_BUFFER_USAGE_ONE_TIME_SUBMIT_BIT};
		CHECK(vkBeginCommandBuffer(cb, &bgi));
		vkCmdBindPipeline(cb, VK_PIPELINE_BIND_POINT_COMPUTE, pipe);
		vkCmdBindDescriptorSets(cb, VK_PIPELINE_BIND_POINT_COMPUTE, pl, 0, 1, &sets[run], 0, NULL);
		vkCmdPushConstants(cb, pl, VK_SHADER_STAGE_COMPUTE_BIT, 0, 4, &scale);
		vkCmdDispatch(cb, (N + 63) / 64, 1, 1);
		CHECK(vkEndCommandBuffer(cb));
		VkSubmitInfo si = {.sType = VK_STRUCTURE_TYPE_SUBMIT_INFO, .commandBufferCount = 1, .pCommandBuffers = &cb};
		CHECK(vkQueueSubmit(c.queue, 1, &si, fence));
		dst.p[4] = (uint8_t)(0x40 + run); /* before the view: the CPU's while the GPU works */
		CHECK(vkWaitForFences(c.dev, 1, &fence, VK_TRUE, UINT64_MAX));
		CHECK(vkResetFences(c.dev, 1, &fence));

		int before = bad;
		const float *d = (const float *)(dst.p + DST_OFF);
		uint32_t want_cnt[4] = {0};
		for (uint32_t i = 0; i < N; i++) {
			const uint8_t *t = src.p + SRC_OFF + 4 * ix[i];
			for (uint32_t k = 0; k < 4; k++)
				expect("dst", i * 4 + k, d[i * 4 + k], (double)(t[k] / 255.0f) * scale);
			want_cnt[ix[i] % 4]++;
		}
		const uint32_t *n = (const uint32_t *)(cnt.p + CNT_OFF);
		for (uint32_t k = 0; k < 4; k++)
			expect("cnt", k, n[k], want_cnt[k]);
		expect("dst byte 4 (CPU-written during the dispatch)", 4, dst.p[4], 0x40 + run);
		for (uint32_t i = 0; i < DST_OFF; i++)
			if (i != 4)
				expect("dst (before the view)", i, dst.p[i], 0xee);
		for (uint32_t i = 0; i < DST_TAIL; i++)
			expect("dst (after the view)", i, dst.p[DST_OFF + N * 16 + i], 0xee);
		for (uint32_t i = 0; i < CNT_OFF; i++)
			expect("cnt (before the view)", i, cnt.p[i], 0);
		printf("vk-texel: %s: %s\n", how[run], bad == before ? "ok" : "FAIL");
	}

	destroy_tpl(c.dev, tpl, NULL);
	for (int i = 0; i < 4; i++)
		vkDestroyBufferView(c.dev, views[i], NULL);
	vkDestroyFence(c.dev, fence, NULL);
	vkDestroyCommandPool(c.dev, pool, NULL);
	vkDestroyDescriptorPool(c.dev, dp, NULL);
	vkDestroyPipeline(c.dev, pipe, NULL);
	vkDestroyPipelineLayout(c.dev, pl, NULL);
	vkDestroyDescriptorSetLayout(c.dev, dsl, NULL);
	struct buf *all[4] = {&src, &idx, &dst, &cnt};
	for (int i = 0; i < 4; i++) {
		vkUnmapMemory(c.dev, all[i]->m);
		vkDestroyBuffer(c.dev, all[i]->b, NULL);
		vkFreeMemory(c.dev, all[i]->m, NULL);
	}
	vkDestroyDevice(c.dev, NULL);
	vkDestroyInstance(c.inst, NULL);
	printf("vk-texel: %s (%d wrong)\n", bad ? "FAIL" : "ok", bad);
	return bad ? 1 : 0;
}
