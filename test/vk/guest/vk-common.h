// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Shared setup for the kwvk test programs: instance, first physical
// device, a device with one queue, memory type lookup, a host-visible buffer.
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <vulkan/vulkan.h>

#define CHECK(x)                                                                      \
	do {                                                                          \
		VkResult r_ = (x);                                                    \
		if (r_ != VK_SUCCESS) {                                               \
			fprintf(stderr, "%s:%d: %s = %d\n", __FILE__, __LINE__, #x, r_); \
			exit(1);                                                      \
		}                                                                     \
	} while (0)

struct ctx {
	VkInstance inst;
	VkPhysicalDevice pd;
	VkDevice dev;
	VkQueue queue;
	VkPhysicalDeviceMemoryProperties mem;
};

/* an instance of API version `api`, a device made with `features` (a pNext chain) */
static inline void ctx_init_api(struct ctx *c, const char *name, uint32_t api, const void *features)
{
	VkApplicationInfo app = {.sType = VK_STRUCTURE_TYPE_APPLICATION_INFO, .pApplicationName = name, .apiVersion = api};
	VkInstanceCreateInfo ici = {.sType = VK_STRUCTURE_TYPE_INSTANCE_CREATE_INFO, .pApplicationInfo = &app};
	CHECK(vkCreateInstance(&ici, NULL, &c->inst));
	uint32_t n = 1;
	VkResult r = vkEnumeratePhysicalDevices(c->inst, &n, &c->pd);
	if ((r != VK_SUCCESS && r != VK_INCOMPLETE) || !n) {
		fprintf(stderr, "no physical device\n");
		exit(1);
	}
	VkPhysicalDeviceProperties p;
	vkGetPhysicalDeviceProperties(c->pd, &p);
	printf("%s: device %s\n", name, p.deviceName);
	vkGetPhysicalDeviceMemoryProperties(c->pd, &c->mem);
	float prio = 1;
	VkDeviceQueueCreateInfo q = {.sType = VK_STRUCTURE_TYPE_DEVICE_QUEUE_CREATE_INFO, .queueFamilyIndex = 0, .queueCount = 1, .pQueuePriorities = &prio};
	VkDeviceCreateInfo dci = {.sType = VK_STRUCTURE_TYPE_DEVICE_CREATE_INFO, .pNext = features, .queueCreateInfoCount = 1, .pQueueCreateInfos = &q};
	CHECK(vkCreateDevice(c->pd, &dci, NULL, &c->dev));
	vkGetDeviceQueue(c->dev, 0, 0, &c->queue);
}

static inline void ctx_init(struct ctx *c, const char *name) { ctx_init_api(c, name, VK_API_VERSION_1_0, NULL); }

static inline uint32_t mem_type(struct ctx *c, uint32_t bits, VkMemoryPropertyFlags want)
{
	for (uint32_t i = 0; i < c->mem.memoryTypeCount; i++)
		if ((bits & (1u << i)) && (c->mem.memoryTypes[i].propertyFlags & want) == want)
			return i;
	fprintf(stderr, "no memory type for %x\n", want);
	exit(1);
}

static inline void host_buffer(struct ctx *c, VkDeviceSize size, VkBufferUsageFlags usage, VkBuffer *buf, VkDeviceMemory *mem)
{
	VkBufferCreateInfo bci = {.sType = VK_STRUCTURE_TYPE_BUFFER_CREATE_INFO, .size = size, .usage = usage};
	CHECK(vkCreateBuffer(c->dev, &bci, NULL, buf));
	VkMemoryRequirements req;
	vkGetBufferMemoryRequirements(c->dev, *buf, &req);
	VkMemoryAllocateInfo ai = {.sType = VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO, .allocationSize = req.size,
		.memoryTypeIndex = mem_type(c, req.memoryTypeBits, VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT | VK_MEMORY_PROPERTY_HOST_COHERENT_BIT)};
	CHECK(vkAllocateMemory(c->dev, &ai, NULL, mem));
	CHECK(vkBindBufferMemory(c->dev, *buf, *mem, 0));
}

static inline VkShaderModule shader(struct ctx *c, const uint32_t *code, size_t size)
{
	VkShaderModuleCreateInfo ci = {.sType = VK_STRUCTURE_TYPE_SHADER_MODULE_CREATE_INFO, .codeSize = size, .pCode = code};
	VkShaderModule m;
	CHECK(vkCreateShaderModule(c->dev, &ci, NULL, &m));
	return m;
}

static inline VkCommandBuffer begin_cmds(struct ctx *c, VkCommandPool *pool)
{
	VkCommandPoolCreateInfo pci = {.sType = VK_STRUCTURE_TYPE_COMMAND_POOL_CREATE_INFO, .queueFamilyIndex = 0};
	CHECK(vkCreateCommandPool(c->dev, &pci, NULL, pool));
	VkCommandBufferAllocateInfo ai = {.sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_ALLOCATE_INFO, .commandPool = *pool,
		.level = VK_COMMAND_BUFFER_LEVEL_PRIMARY, .commandBufferCount = 1};
	VkCommandBuffer cb;
	CHECK(vkAllocateCommandBuffers(c->dev, &ai, &cb));
	VkCommandBufferBeginInfo bi = {.sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO, .flags = VK_COMMAND_BUFFER_USAGE_ONE_TIME_SUBMIT_BIT};
	CHECK(vkBeginCommandBuffer(cb, &bi));
	return cb;
}

static inline void submit_wait(struct ctx *c, VkCommandBuffer cb)
{
	CHECK(vkEndCommandBuffer(cb));
	VkFenceCreateInfo fci = {.sType = VK_STRUCTURE_TYPE_FENCE_CREATE_INFO};
	VkFence f;
	CHECK(vkCreateFence(c->dev, &fci, NULL, &f));
	VkSubmitInfo si = {.sType = VK_STRUCTURE_TYPE_SUBMIT_INFO, .commandBufferCount = 1, .pCommandBuffers = &cb};
	CHECK(vkQueueSubmit(c->queue, 1, &si, f));
	CHECK(vkWaitForFences(c->dev, 1, &f, VK_TRUE, UINT64_MAX));
	vkDestroyFence(c->dev, f, NULL);
}
