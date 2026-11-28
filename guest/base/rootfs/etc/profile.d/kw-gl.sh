# SPDX-License-Identifier: GPL-2.0-or-later
# Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
# /etc/profile.d/kw-gl.sh (the kw layer, every distro): with guest GL on
# (kw.gl=1 on the kernel command line, which the page adds with its GL
# option; .agents/gl.md), Mesa renders through the host's WebGL2. With a
# DRM render node (the host's virtio-gpu device, createKernel({ gpu })),
# Mesa finds its virtio_gpu (virgl) driver on /dev/dri by itself, so this
# sets no driver. Without one, it points Mesa at the vtest link: its virgl
# driver over vtest (GALLIUM_DRIVER=virpipe; LIBGL_ALWAYS_SOFTWARE=1 makes
# GLX and EGL take Mesa's software path, where GALLIUM_DRIVER picks the
# driver) to /tmp/.virgl_test, the socket of kwbox vtest.
# `GALLIUM_DRIVER=virpipe LIBGL_ALWAYS_SOFTWARE=1 cmd` runs one program on
# the vtest link with the device there too; `GALLIUM_DRIVER=llvmpipe cmd`
# (vtest) or `LIBGL_ALWAYS_SOFTWARE=1 cmd` (DRM) on llvmpipe instead.
# Mesa itself is not in the images (apt-get install mesa-utils ...).
# Always (guest GL on or off): LIBGL_KOPPER_DISABLE=1, so that Mesa's GLX
# never falls back to zink on the first Vulkan device when its driver
# fails on a DRI3 X server: that is kwvk (guest Vulkan on WebGPU,
# .agents/vk.md, Unsupported), which lacks much of what zink needs; GLX
# then takes llvmpipe.
# `LIBGL_KOPPER_DISABLE=0 cmd` lets one program try zink.
# Shell builtins only: every shell start reads this.

export LIBGL_KOPPER_DISABLE=1

if [ -r /proc/cmdline ]; then
	read -r _kw_cmdline < /proc/cmdline || :
	case " $_kw_cmdline " in
	*" kw.gl=1 "*)
		_kw_drm=
		for _kw_f in /dev/dri/renderD*; do [ -e "$_kw_f" ] && _kw_drm=1; done
		[ -n "$_kw_drm" ] || export GALLIUM_DRIVER=virpipe LIBGL_ALWAYS_SOFTWARE=1
		unset _kw_drm _kw_f
		;;
	esac
	unset _kw_cmdline
fi
