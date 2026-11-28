// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// kwvk depth and culling test: a near red triangle drawn before a far
// green one that overlaps it, with a D32 depth attachment cleared to 1 and
// LESS: the overlap must stay red; the green one winds the other way and
// is culled as back-facing. Drawn twice, with a normal and with a negative
// viewport height (VK_KHR_maintenance1), and with the depth cleared by a
// depth-only render pass of its own and loaded by the next (as vkd3d
// does), counting the passed samples with an occlusion query. Then with
// Vulkan 1.2's imagelessFramebuffer and separateDepthStencilLayouts: a
// render pass made by vkCreateRenderPass2 with the depth-only layouts
// (DEPTH_ATTACHMENT_OPTIMAL, stencil layouts chained), an imageless
// framebuffer begun with two sets of views in one command buffer (a scratch
// image first, then the one read back). Exit 0 on success.
#include "vk-common.h"

#include "depth_frag.h"
#include "depth_vert.h"

#define W 64
#define H 64

/* the color attachment of mode 3's first pass, which draws into it instead */
static VkImage scratch_image(struct ctx *c, VkFormat fmt, VkDeviceMemory *mem, VkImageView *view)
{
	VkImageCreateInfo ici = {.sType = VK_STRUCTURE_TYPE_IMAGE_CREATE_INFO, .imageType = VK_IMAGE_TYPE_2D, .format = fmt,
		.extent = {W, H, 1}, .mipLevels = 1, .arrayLayers = 1, .samples = VK_SAMPLE_COUNT_1_BIT, .tiling = VK_IMAGE_TILING_OPTIMAL,
		.usage = VK_IMAGE_USAGE_COLOR_ATTACHMENT_BIT | VK_IMAGE_USAGE_TRANSFER_SRC_BIT};
	VkImage img;
	CHECK(vkCreateImage(c->dev, &ici, NULL, &img));
	VkMemoryRequirements req;
	vkGetImageMemoryRequirements(c->dev, img, &req);
	VkMemoryAllocateInfo mai = {.sType = VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO, .allocationSize = req.size,
		.memoryTypeIndex = mem_type(c, req.memoryTypeBits, VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT)};
	CHECK(vkAllocateMemory(c->dev, &mai, NULL, mem));
	CHECK(vkBindImageMemory(c->dev, img, *mem, 0));
	VkImageViewCreateInfo vci = {.sType = VK_STRUCTURE_TYPE_IMAGE_VIEW_CREATE_INFO, .image = img, .viewType = VK_IMAGE_VIEW_TYPE_2D,
		.format = fmt, .subresourceRange = {VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, 1}};
	CHECK(vkCreateImageView(c->dev, &vci, NULL, view));
	return img;
}

/* mode 0: one pass; 1: negative viewport; 2: the depth cleared by a depth-only render pass of its own, then loaded (vkd3d);
 * 3: mode 0 with vkCreateRenderPass2, depth-only layouts and an imageless framebuffer begun twice */
static int run(struct ctx *cp, int mode)
{
	struct ctx c = *cp;
	VkFormat fmt = VK_FORMAT_R8G8B8A8_UNORM;
	VkImageCreateInfo ici = {.sType = VK_STRUCTURE_TYPE_IMAGE_CREATE_INFO, .imageType = VK_IMAGE_TYPE_2D, .format = fmt,
		.extent = {W, H, 1}, .mipLevels = 1, .arrayLayers = 1, .samples = VK_SAMPLE_COUNT_1_BIT, .tiling = VK_IMAGE_TILING_OPTIMAL,
		.usage = VK_IMAGE_USAGE_COLOR_ATTACHMENT_BIT | VK_IMAGE_USAGE_TRANSFER_SRC_BIT};
	VkImage img;
	CHECK(vkCreateImage(c.dev, &ici, NULL, &img));
	VkMemoryRequirements req;
	vkGetImageMemoryRequirements(c.dev, img, &req);
	VkMemoryAllocateInfo mai = {.sType = VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO, .allocationSize = req.size,
		.memoryTypeIndex = mem_type(&c, req.memoryTypeBits, VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT)};
	VkDeviceMemory imem;
	CHECK(vkAllocateMemory(c.dev, &mai, NULL, &imem));
	CHECK(vkBindImageMemory(c.dev, img, imem, 0));
	VkImageViewCreateInfo vci = {.sType = VK_STRUCTURE_TYPE_IMAGE_VIEW_CREATE_INFO, .image = img, .viewType = VK_IMAGE_VIEW_TYPE_2D,
		.format = fmt, .subresourceRange = {VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, 1}};
	VkImageView view;
	CHECK(vkCreateImageView(c.dev, &vci, NULL, &view));

	VkImageCreateInfo dci = ici;
	dci.format = VK_FORMAT_D32_SFLOAT;
	dci.usage = VK_IMAGE_USAGE_DEPTH_STENCIL_ATTACHMENT_BIT;
	VkImage dimg;
	CHECK(vkCreateImage(c.dev, &dci, NULL, &dimg));
	VkDeviceMemory dmem;
	CHECK(vkAllocateMemory(c.dev, &mai, NULL, &dmem));
	CHECK(vkBindImageMemory(c.dev, dimg, dmem, 0));
	VkImageViewCreateInfo dvci = vci;
	dvci.image = dimg;
	dvci.format = VK_FORMAT_D32_SFLOAT;
	dvci.subresourceRange.aspectMask = VK_IMAGE_ASPECT_DEPTH_BIT;
	VkImageView dview;
	CHECK(vkCreateImageView(c.dev, &dvci, NULL, &dview));
	VkAttachmentDescription att = {.format = fmt, .samples = VK_SAMPLE_COUNT_1_BIT, .loadOp = VK_ATTACHMENT_LOAD_OP_CLEAR,
		.storeOp = VK_ATTACHMENT_STORE_OP_STORE, .stencilLoadOp = VK_ATTACHMENT_LOAD_OP_DONT_CARE,
		.stencilStoreOp = VK_ATTACHMENT_STORE_OP_DONT_CARE, .initialLayout = VK_IMAGE_LAYOUT_UNDEFINED,
		.finalLayout = VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL};
	VkAttachmentDescription datt = {.format = VK_FORMAT_D32_SFLOAT, .samples = VK_SAMPLE_COUNT_1_BIT, .loadOp = VK_ATTACHMENT_LOAD_OP_CLEAR,
		.storeOp = VK_ATTACHMENT_STORE_OP_DONT_CARE, .stencilLoadOp = VK_ATTACHMENT_LOAD_OP_DONT_CARE,
		.stencilStoreOp = VK_ATTACHMENT_STORE_OP_DONT_CARE, .initialLayout = VK_IMAGE_LAYOUT_UNDEFINED,
		.finalLayout = VK_IMAGE_LAYOUT_DEPTH_STENCIL_ATTACHMENT_OPTIMAL};
	if (mode == 2) {
		datt.loadOp = VK_ATTACHMENT_LOAD_OP_LOAD;
		datt.initialLayout = VK_IMAGE_LAYOUT_DEPTH_STENCIL_ATTACHMENT_OPTIMAL;
	}
	VkAttachmentDescription catt = datt;
	catt.loadOp = VK_ATTACHMENT_LOAD_OP_CLEAR;
	catt.storeOp = VK_ATTACHMENT_STORE_OP_STORE;
	catt.initialLayout = VK_IMAGE_LAYOUT_UNDEFINED;
	VkAttachmentReference cref = {0, VK_IMAGE_LAYOUT_DEPTH_STENCIL_ATTACHMENT_OPTIMAL};
	VkSubpassDescription csub = {.pipelineBindPoint = VK_PIPELINE_BIND_POINT_GRAPHICS, .pDepthStencilAttachment = &cref};
	VkRenderPassCreateInfo crpci = {.sType = VK_STRUCTURE_TYPE_RENDER_PASS_CREATE_INFO, .attachmentCount = 1, .pAttachments = &catt,
		.subpassCount = 1, .pSubpasses = &csub};
	VkRenderPass crp;
	CHECK(vkCreateRenderPass(c.dev, &crpci, NULL, &crp));
	VkFramebufferCreateInfo cfci = {.sType = VK_STRUCTURE_TYPE_FRAMEBUFFER_CREATE_INFO, .renderPass = crp, .attachmentCount = 1,
		.pAttachments = &dview, .width = W, .height = H, .layers = 1};
	VkFramebuffer cfb;
	CHECK(vkCreateFramebuffer(c.dev, &cfci, NULL, &cfb));
	VkAttachmentDescription atts[2] = {att, datt};
	VkAttachmentReference ref = {0, VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL};
	VkAttachmentReference dref = {1, VK_IMAGE_LAYOUT_DEPTH_STENCIL_ATTACHMENT_OPTIMAL};
	VkSubpassDescription sub = {.pipelineBindPoint = VK_PIPELINE_BIND_POINT_GRAPHICS, .colorAttachmentCount = 1, .pColorAttachments = &ref,
		.pDepthStencilAttachment = &dref};
	VkRenderPassCreateInfo rpci = {.sType = VK_STRUCTURE_TYPE_RENDER_PASS_CREATE_INFO, .attachmentCount = 2, .pAttachments = atts,
		.subpassCount = 1, .pSubpasses = &sub};
	VkRenderPass rp = VK_NULL_HANDLE;
	VkImageView fbviews[2] = {view, dview};
	VkFramebufferCreateInfo fci = {.sType = VK_STRUCTURE_TYPE_FRAMEBUFFER_CREATE_INFO, .renderPass = rp, .attachmentCount = 2,
		.pAttachments = fbviews, .width = W, .height = H, .layers = 1};
	VkImage simg = VK_NULL_HANDLE;
	VkImageView sview = VK_NULL_HANDLE;
	VkDeviceMemory smem = VK_NULL_HANDLE;
	if (mode == 3) {
		/* the same pass as vkCreateRenderPass2, with the depth aspect's own layouts */
		VkAttachmentDescriptionStencilLayout dsl = {.sType = VK_STRUCTURE_TYPE_ATTACHMENT_DESCRIPTION_STENCIL_LAYOUT,
			.stencilInitialLayout = VK_IMAGE_LAYOUT_UNDEFINED, .stencilFinalLayout = VK_IMAGE_LAYOUT_STENCIL_ATTACHMENT_OPTIMAL};
		VkAttachmentDescription2 a2[2] = {
			{.sType = VK_STRUCTURE_TYPE_ATTACHMENT_DESCRIPTION_2, .format = att.format, .samples = att.samples, .loadOp = att.loadOp,
				.storeOp = att.storeOp, .stencilLoadOp = att.stencilLoadOp, .stencilStoreOp = att.stencilStoreOp,
				.initialLayout = att.initialLayout, .finalLayout = att.finalLayout},
			{.sType = VK_STRUCTURE_TYPE_ATTACHMENT_DESCRIPTION_2, .pNext = &dsl, .format = datt.format, .samples = datt.samples,
				.loadOp = datt.loadOp, .storeOp = datt.storeOp, .stencilLoadOp = datt.stencilLoadOp, .stencilStoreOp = datt.stencilStoreOp,
				.initialLayout = VK_IMAGE_LAYOUT_UNDEFINED, .finalLayout = VK_IMAGE_LAYOUT_DEPTH_ATTACHMENT_OPTIMAL},
		};
		VkAttachmentReferenceStencilLayout rsl = {.sType = VK_STRUCTURE_TYPE_ATTACHMENT_REFERENCE_STENCIL_LAYOUT,
			.stencilLayout = VK_IMAGE_LAYOUT_STENCIL_ATTACHMENT_OPTIMAL};
		VkAttachmentReference2 r2 = {.sType = VK_STRUCTURE_TYPE_ATTACHMENT_REFERENCE_2, .attachment = 0,
			.layout = VK_IMAGE_LAYOUT_COLOR_ATTACHMENT_OPTIMAL, .aspectMask = VK_IMAGE_ASPECT_COLOR_BIT};
		VkAttachmentReference2 dr2 = {.sType = VK_STRUCTURE_TYPE_ATTACHMENT_REFERENCE_2, .pNext = &rsl, .attachment = 1,
			.layout = VK_IMAGE_LAYOUT_DEPTH_ATTACHMENT_OPTIMAL, .aspectMask = VK_IMAGE_ASPECT_DEPTH_BIT};
		VkSubpassDescription2 sub2 = {.sType = VK_STRUCTURE_TYPE_SUBPASS_DESCRIPTION_2, .pipelineBindPoint = VK_PIPELINE_BIND_POINT_GRAPHICS,
			.colorAttachmentCount = 1, .pColorAttachments = &r2, .pDepthStencilAttachment = &dr2};
		VkRenderPassCreateInfo2 rpci2 = {.sType = VK_STRUCTURE_TYPE_RENDER_PASS_CREATE_INFO_2, .attachmentCount = 2, .pAttachments = a2,
			.subpassCount = 1, .pSubpasses = &sub2};
		CHECK(vkCreateRenderPass2(c.dev, &rpci2, NULL, &rp));
		simg = scratch_image(&c, fmt, &smem, &sview);
	} else {
		CHECK(vkCreateRenderPass(c.dev, &rpci, NULL, &rp));
	}
	fci.renderPass = rp;
	/* imageless: what the views must be like, the views at each begin */
	VkFormat cfmt = fmt, dfmt = VK_FORMAT_D32_SFLOAT;
	VkFramebufferAttachmentImageInfo fai[2] = {
		{.sType = VK_STRUCTURE_TYPE_FRAMEBUFFER_ATTACHMENT_IMAGE_INFO, .usage = ici.usage, .width = W, .height = H, .layerCount = 1,
			.viewFormatCount = 1, .pViewFormats = &cfmt},
		{.sType = VK_STRUCTURE_TYPE_FRAMEBUFFER_ATTACHMENT_IMAGE_INFO, .usage = dci.usage, .width = W, .height = H, .layerCount = 1,
			.viewFormatCount = 1, .pViewFormats = &dfmt},
	};
	VkFramebufferAttachmentsCreateInfo faci = {.sType = VK_STRUCTURE_TYPE_FRAMEBUFFER_ATTACHMENTS_CREATE_INFO, .attachmentImageInfoCount = 2,
		.pAttachmentImageInfos = fai};
	if (mode == 3) {
		fci.pNext = &faci;
		fci.flags = VK_FRAMEBUFFER_CREATE_IMAGELESS_BIT;
		fci.pAttachments = NULL;
	}
	VkFramebuffer fb;
	CHECK(vkCreateFramebuffer(c.dev, &fci, NULL, &fb));

	VkPipelineLayoutCreateInfo plci = {.sType = VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO};
	VkPipelineLayout pl;
	CHECK(vkCreatePipelineLayout(c.dev, &plci, NULL, &pl));
	VkPipelineShaderStageCreateInfo stages[2] = {
		{.sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO, .stage = VK_SHADER_STAGE_VERTEX_BIT,
			.module = shader(&c, spv_depth_vert, sizeof spv_depth_vert), .pName = "main"},
		{.sType = VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO, .stage = VK_SHADER_STAGE_FRAGMENT_BIT,
			.module = shader(&c, spv_depth_frag, sizeof spv_depth_frag), .pName = "main"},
	};
	VkPipelineVertexInputStateCreateInfo vis = {.sType = VK_STRUCTURE_TYPE_PIPELINE_VERTEX_INPUT_STATE_CREATE_INFO};
	VkPipelineInputAssemblyStateCreateInfo ias = {.sType = VK_STRUCTURE_TYPE_PIPELINE_INPUT_ASSEMBLY_STATE_CREATE_INFO,
		.topology = VK_PRIMITIVE_TOPOLOGY_TRIANGLE_LIST};
	VkViewport vp = mode == 1 ? (VkViewport){0, H, W, -(float)H, 0, 1} : (VkViewport){0, 0, W, H, 0, 1};
	VkRect2D sc = {{0, 0}, {W, H}};
	VkPipelineViewportStateCreateInfo vps = {.sType = VK_STRUCTURE_TYPE_PIPELINE_VIEWPORT_STATE_CREATE_INFO, .viewportCount = 1,
		.pViewports = &vp, .scissorCount = 1, .pScissors = &sc};
	VkPipelineRasterizationStateCreateInfo rs = {.sType = VK_STRUCTURE_TYPE_PIPELINE_RASTERIZATION_STATE_CREATE_INFO,
		.polygonMode = VK_POLYGON_MODE_FILL, .cullMode = VK_CULL_MODE_BACK_BIT,
		/* the red triangle is clockwise in framebuffer space, counter-clockwise when flipped */
		.frontFace = mode == 1 ? VK_FRONT_FACE_COUNTER_CLOCKWISE : VK_FRONT_FACE_CLOCKWISE, .lineWidth = 1};
	VkPipelineMultisampleStateCreateInfo ms = {.sType = VK_STRUCTURE_TYPE_PIPELINE_MULTISAMPLE_STATE_CREATE_INFO,
		.rasterizationSamples = VK_SAMPLE_COUNT_1_BIT};
	VkPipelineDepthStencilStateCreateInfo dss = {.sType = VK_STRUCTURE_TYPE_PIPELINE_DEPTH_STENCIL_STATE_CREATE_INFO, .depthTestEnable = 1,
		.depthWriteEnable = 1, .depthCompareOp = VK_COMPARE_OP_LESS};
	VkPipelineColorBlendAttachmentState cba = {.colorWriteMask = 0xf};
	VkPipelineColorBlendStateCreateInfo cbs = {.sType = VK_STRUCTURE_TYPE_PIPELINE_COLOR_BLEND_STATE_CREATE_INFO, .attachmentCount = 1,
		.pAttachments = &cba};
	VkGraphicsPipelineCreateInfo gpci = {.sType = VK_STRUCTURE_TYPE_GRAPHICS_PIPELINE_CREATE_INFO, .stageCount = 2, .pStages = stages,
		.pVertexInputState = &vis, .pInputAssemblyState = &ias, .pViewportState = &vps, .pRasterizationState = &rs,
		.pMultisampleState = &ms, .pDepthStencilState = &dss, .pColorBlendState = &cbs, .layout = pl, .renderPass = rp, .subpass = 0};
	VkPipeline pipe;
	CHECK(vkCreateGraphicsPipelines(c.dev, VK_NULL_HANDLE, 1, &gpci, NULL, &pipe));

	VkBuffer buf;
	VkDeviceMemory bmem;
	host_buffer(&c, W * H * 4, VK_BUFFER_USAGE_TRANSFER_DST_BIT, &buf, &bmem);

	VkCommandPool pool;
	VkCommandBuffer cb = begin_cmds(&c, &pool);
	VkClearValue clears[2] = {{.color = {.float32 = {0, 0, 1, 1}}}, {.depthStencil = {1.0f, 0}}};
	VkRenderPassBeginInfo rpbi = {.sType = VK_STRUCTURE_TYPE_RENDER_PASS_BEGIN_INFO, .renderPass = rp, .framebuffer = fb,
		.renderArea = {{0, 0}, {W, H}}, .clearValueCount = 2, .pClearValues = clears};
	VkQueryPoolCreateInfo qpci = {.sType = VK_STRUCTURE_TYPE_QUERY_POOL_CREATE_INFO, .queryType = VK_QUERY_TYPE_OCCLUSION, .queryCount = 1};
	VkQueryPool qp;
	CHECK(vkCreateQueryPool(c.dev, &qpci, NULL, &qp));
	vkCmdResetQueryPool(cb, qp, 0, 1);
	if (mode == 2) {
		VkClearValue dclear = {.depthStencil = {1.0f, 0}};
		VkRenderPassBeginInfo cbi = {.sType = VK_STRUCTURE_TYPE_RENDER_PASS_BEGIN_INFO, .renderPass = crp, .framebuffer = cfb,
			.renderArea = {{0, 0}, {W, H}}, .clearValueCount = 1, .pClearValues = &dclear};
		vkCmdBeginRenderPass(cb, &cbi, VK_SUBPASS_CONTENTS_INLINE);
		vkCmdEndRenderPass(cb);
	}
	VkSubpassBeginInfo sbi = {.sType = VK_STRUCTURE_TYPE_SUBPASS_BEGIN_INFO, .contents = VK_SUBPASS_CONTENTS_INLINE};
	VkSubpassEndInfo sei = {.sType = VK_STRUCTURE_TYPE_SUBPASS_END_INFO};
	VkImageView sviews[2] = {sview, dview};
	VkRenderPassAttachmentBeginInfo rpab = {.sType = VK_STRUCTURE_TYPE_RENDER_PASS_ATTACHMENT_BEGIN_INFO, .attachmentCount = 2,
		.pAttachments = sviews};
	if (mode == 3) {
		/* first into the scratch image (cleared green, drawn over), then into
		 * the one read back: each begin draws into its own views */
		VkClearValue sclears[2] = {{.color = {.float32 = {0, 1, 0, 1}}}, {.depthStencil = {1.0f, 0}}};
		VkRenderPassBeginInfo sbegin = rpbi;
		sbegin.pNext = &rpab;
		sbegin.pClearValues = sclears;
		vkCmdBeginRenderPass2(cb, &sbegin, &sbi);
		vkCmdBindPipeline(cb, VK_PIPELINE_BIND_POINT_GRAPHICS, pipe);
		vkCmdDraw(cb, 6, 1, 0, 0);
		vkCmdEndRenderPass2(cb, &sei);
	}
	VkRenderPassAttachmentBeginInfo rpab2 = rpab;
	rpab2.pAttachments = fbviews;
	if (mode == 3)
		rpbi.pNext = &rpab2;
	vkCmdBeginRenderPass(cb, &rpbi, VK_SUBPASS_CONTENTS_INLINE);
	vkCmdBindPipeline(cb, VK_PIPELINE_BIND_POINT_GRAPHICS, pipe);
	vkCmdBeginQuery(cb, qp, 0, 0);
	vkCmdDraw(cb, 6, 1, 0, 0);
	vkCmdEndQuery(cb, qp, 0);
	vkCmdEndRenderPass(cb);
	VkBufferImageCopy region = {.bufferOffset = 0, .imageSubresource = {VK_IMAGE_ASPECT_COLOR_BIT, 0, 0, 1}, .imageExtent = {W, H, 1}};
	vkCmdCopyImageToBuffer(cb, img, VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL, buf, 1, &region);
	VkBuffer sbuf = VK_NULL_HANDLE;
	VkDeviceMemory sbmem = VK_NULL_HANDLE;
	if (mode == 3) {
		host_buffer(&c, W * H * 4, VK_BUFFER_USAGE_TRANSFER_DST_BIT, &sbuf, &sbmem);
		vkCmdCopyImageToBuffer(cb, simg, VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL, sbuf, 1, &region);
	}
	submit_wait(&c, cb);

	uint64_t samples[2] = {0, 0};
	VkResult qr = vkGetQueryPoolResults(c.dev, qp, 0, 1, sizeof samples, samples, sizeof samples,
					    VK_QUERY_RESULT_64_BIT | VK_QUERY_RESULT_WAIT_BIT | VK_QUERY_RESULT_WITH_AVAILABILITY_BIT);
	int qbad = qr != VK_SUCCESS || !samples[0] || !samples[1];
	printf("  occlusion query: result %d, %llu samples passed, available %llu %s\n", qr, (unsigned long long)samples[0],
	       (unsigned long long)samples[1], qbad ? "WRONG" : "ok");
	vkDestroyQueryPool(c.dev, qp, NULL);
	uint8_t *p;
	CHECK(vkMapMemory(c.dev, bmem, 0, VK_WHOLE_SIZE, 0, (void **)&p));
	const struct {
		int x, y, red;
	} probe[] = {{32, 32, 1}, {32, 30, 1}, {1, 1, 0}, {10, mode == 1 ? 7 : 56, 0} /* green only, which is back-facing: culled */};
	int bad = qbad;
	for (size_t i = 0; i < sizeof probe / sizeof *probe; i++) {
		const uint8_t *px = p + (probe[i].y * W + probe[i].x) * 4;
		int want_r = probe[i].red ? 255 : 0, want_b = probe[i].red ? 0 : 255;
		int ok = abs(px[0] - want_r) < 3 && px[1] < 3 && abs(px[2] - want_b) < 3 && px[3] > 252;
		printf("  (%d,%d) = %02x%02x%02x%02x want %s %s\n", probe[i].x, probe[i].y, px[0], px[1], px[2], px[3],
		       probe[i].red ? "red" : "blue", ok ? "ok" : "WRONG");
		bad += !ok;
	}
	vkUnmapMemory(c.dev, bmem);
	if (mode == 3) {
		/* the first begin's views: the scratch image, cleared green and drawn */
		CHECK(vkMapMemory(c.dev, sbmem, 0, VK_WHOLE_SIZE, 0, (void **)&p));
		const uint8_t *g = p + (1 * W + 1) * 4, *r = p + (32 * W + 32) * 4;
		int ok = g[0] < 3 && g[1] > 252 && g[2] < 3 && r[0] > 252 && r[1] < 3 && r[2] < 3;
		printf("  scratch image (first begin): (1,1) = %02x%02x%02x%02x want green, (32,32) = %02x%02x%02x%02x want red %s\n", g[0], g[1], g[2],
		       g[3], r[0], r[1], r[2], r[3], ok ? "ok" : "WRONG");
		bad += !ok;
		vkUnmapMemory(c.dev, sbmem);
		vkDestroyBuffer(c.dev, sbuf, NULL);
		vkFreeMemory(c.dev, sbmem, NULL);
	}
	CHECK(vkDeviceWaitIdle(c.dev));
	vkDestroyCommandPool(c.dev, pool, NULL);
	vkDestroyPipeline(c.dev, pipe, NULL);
	vkDestroyPipelineLayout(c.dev, pl, NULL);
	vkDestroyFramebuffer(c.dev, fb, NULL);
	vkDestroyRenderPass(c.dev, rp, NULL);
	vkDestroyImageView(c.dev, view, NULL);
	vkDestroyImage(c.dev, img, NULL);
	vkFreeMemory(c.dev, imem, NULL);
	vkDestroyBuffer(c.dev, buf, NULL);
	vkFreeMemory(c.dev, bmem, NULL);
	vkDestroyFramebuffer(c.dev, cfb, NULL);
	vkDestroyRenderPass(c.dev, crp, NULL);
	vkDestroyImageView(c.dev, dview, NULL);
	vkDestroyImage(c.dev, dimg, NULL);
	vkFreeMemory(c.dev, dmem, NULL);
	if (simg) {
		vkDestroyImageView(c.dev, sview, NULL);
		vkDestroyImage(c.dev, simg, NULL);
		vkFreeMemory(c.dev, smem, NULL);
	}
	return bad;
}

int main(void)
{
	struct ctx c;
	VkPhysicalDeviceVulkan12Features f12 = {.sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_VULKAN_1_2_FEATURES, .imagelessFramebuffer = VK_TRUE,
		.separateDepthStencilLayouts = VK_TRUE};
	ctx_init_api(&c, "vk-depth", VK_API_VERSION_1_2, &f12);
	int bad = run(&c, 0);
	printf("  (negative viewport height)\n");
	bad += run(&c, 1);
	printf("  (depth cleared by a render pass of its own, then loaded)\n");
	bad += run(&c, 2);
	VkPhysicalDeviceVulkan12Features got = {.sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_VULKAN_1_2_FEATURES};
	VkPhysicalDeviceFeatures2 f2 = {.sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_FEATURES_2, .pNext = &got};
	vkGetPhysicalDeviceFeatures2(c.pd, &f2);
	printf("  (vkCreateRenderPass2, depth-only layouts, an imageless framebuffer begun twice; imagelessFramebuffer %u, separateDepthStencilLayouts %u)\n",
	       got.imagelessFramebuffer, got.separateDepthStencilLayouts);
	bad += !got.imagelessFramebuffer || !got.separateDepthStencilLayouts;
	bad += run(&c, 3);
	vkDestroyDevice(c.dev, NULL);
	vkDestroyInstance(c.inst, NULL);
	printf("vk-depth: %s\n", bad ? "FAIL" : "ok");
	return bad ? 1 : 0;
}
