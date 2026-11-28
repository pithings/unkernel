// SPDX-License-Identifier: MIT
// Copyright (C) 2026 Pooya Parsa <pooya@pi0.io>
// Neovim: Neovim 0.12 from Alpine's community repository (about 7 MB with
// its libraries), or Debian's 0.10, which lacks some of what follows, with a small config of its own and no plugins (each
// would be a download on every first launch): a start screen, a Space menu
// that lists its keys after a pause, a fuzzy finder, a floating terminal,
// a status line and the page's colours. Neovim itself brings tree-sitter
// highlighting (C, Lua and Markdown grammars come with it), completion as
// you type, rounded floats and the new message UI.
//
// The config goes to config/nvim/init.lua, which run.sh hands to nvim as
// XDG_CONFIG_HOME, so ~/.config/nvim stays untouched. It is a String.raw
// template, so Lua's backslashes stay as written (no backticks or ${ in it).
import type { TerminalApp } from "../types.ts";

const INIT = String.raw`-- The unkernel Neovim demo's config: no plugins, one file.
local o, api = vim.opt, vim.api
local ns = api.nvim_create_namespace("uk")
vim.g.mapleader = " "

o.termguicolors = true
o.mouse = "a"
o.number = true
o.relativenumber = true
o.cursorline = true
o.signcolumn = "yes"
o.scrolloff = 6
o.wrap = false
o.splitright, o.splitbelow = true, true
o.ignorecase, o.smartcase = true, true
o.tabstop, o.shiftwidth = 4, 0
o.undofile = true
o.showmode = false
o.laststatus = 3
o.pumheight = 12
o.fillchars = { eob = " " }
o.list = true
o.listchars = { tab = "│ ", trail = "·", leadmultispace = "│   " }
o.shortmess:append("sI")
-- fuzzy and winborder are 0.11 (Debian's Neovim is 0.10): pcall'd.
if not pcall(function() o.completeopt = { "menuone", "noselect", "popup", "fuzzy" } end) then
	pcall(function() o.completeopt = { "menuone", "noselect", "popup" } end)
end
pcall(function() o.winborder = "rounded" end)
pcall(function() vim.o.autocomplete = true end) -- completion as you type (0.12)
pcall(function() vim.o.pumborder = "rounded" end)
-- 0.12's message UI: no "Press ENTER", and no command line row until used.
if pcall(function() require("vim._core.ui2").enable({}) end) then o.cmdheight = 0 end

-- The netrw file tree (Space e).
vim.g.netrw_banner, vim.g.netrw_liststyle, vim.g.netrw_winsize = 0, 3, 25

-- Colours: the page's black, greys and accents --------------------------------
local c = {
	bg = "#000000", panel = "#0a0a0a", line = "#242424", fg = "#ededed", muted = "#a1a1a1", faint = "#7d7d7d",
	blue = "#52a8ff", purple = "#c472fb", pink = "#f75f8f", green = "#45d483", amber = "#f5a524",
	teal = "#0ac7b4", red = "#ff6166", yellow = "#ffc96b", sky = "#8ec5ff",
}
local function hl(name, spec) api.nvim_set_hl(0, name, spec) end
local function mix(a, b, t)
	local x = {}
	for i = 0, 2 do
		local p, q = tonumber(a:sub(2 + i * 2, 3 + i * 2), 16), tonumber(b:sub(2 + i * 2, 3 + i * 2), 16)
		x[#x + 1] = math.floor(p + (q - p) * t + 0.5)
	end
	return string.format("#%02x%02x%02x", unpack(x))
end

for name, spec in pairs({
	Normal = { fg = c.fg, bg = c.bg }, NormalFloat = { fg = c.fg, bg = c.panel },
	FloatBorder = { fg = "#333333", bg = c.panel }, FloatTitle = { fg = c.bg, bg = c.blue, bold = true },
	FloatFooter = { fg = c.faint, bg = c.panel }, CursorLine = { bg = "#0e0e0e" },
	CursorLineNr = { fg = c.blue, bold = true }, LineNr = { fg = "#3a3a3a" }, Whitespace = { fg = "#1c1c1c" },
	Visual = { bg = "#11325a" }, Search = { fg = c.bg, bg = c.amber }, CurSearch = { fg = c.bg, bg = c.blue },
	Pmenu = { fg = c.muted, bg = c.panel }, PmenuSel = { fg = c.fg, bg = "#16283d", bold = true },
	PmenuMatch = { fg = c.blue, bold = true }, PmenuBorder = { fg = "#333333", bg = c.panel },
	WinSeparator = { fg = c.line }, StatusLine = { fg = c.muted, bg = c.panel }, Directory = { fg = c.sky },
	Comment = { fg = c.faint, italic = true }, String = { fg = c.green }, Number = { fg = c.amber },
	Constant = { fg = c.amber }, Boolean = { fg = c.amber }, Function = { fg = c.blue },
	Statement = { fg = c.pink }, Keyword = { fg = c.pink }, Type = { fg = c.teal }, PreProc = { fg = c.purple },
	Special = { fg = c.yellow }, Operator = { fg = c.muted }, Delimiter = { fg = c.faint },
	["@variable"] = { fg = c.fg }, ["@property"] = { fg = c.sky }, ["@variable.member"] = { fg = c.sky },
	["@markup.heading"] = { fg = c.blue, bold = true }, ["@markup.raw"] = { fg = c.teal },
	UkFile = { fg = c.fg, bg = c.panel, bold = true }, UkDim = { fg = c.faint, bg = c.panel },
	UkMod = { fg = c.amber, bg = c.panel }, UkKey = { fg = c.blue, bold = true }, UkFaint = { fg = c.faint },
}) do hl(name, spec) end
for i = 0, 7 do hl("UkLogo" .. i, { fg = mix(c.blue, c.purple, i / 7), bold = true }) end

-- The status line: the mode in its colour, the file, the position ------------
local modes = {
	n = { "NORMAL", c.blue }, i = { "INSERT", c.green }, v = { "VISUAL", c.purple }, V = { "V-LINE", c.purple },
	["\22"] = { "V-BLOCK", c.purple }, c = { "COMMAND", c.amber }, R = { "REPLACE", c.red }, t = { "TERMINAL", c.teal },
}
for k, m in pairs(modes) do
	hl("UkMode" .. m[1], { fg = c.bg, bg = m[2], bold = true })
	hl("UkEdge" .. m[1], { fg = m[2], bg = c.panel })
end
function _G.uk_status()
	local m = (modes[api.nvim_get_mode().mode:sub(1, 1)] or modes.n)[1]
	local name = vim.fn.expand("%:~:.")
	local ts = vim.treesitter.highlighter.active[api.nvim_get_current_buf()] and " · tree-sitter" or ""
	return table.concat({
		"%#UkMode", m, "# ", m, " %#UkEdge", m, "#▌ %#UkFile#", name == "" and "[no name]" or (name:gsub("%%", "%%%%")),
		"%#UkMod#", vim.bo.modified and " ●" or "", "%=%#UkDim#", vim.bo.filetype, ts, "  %#UkMode", m, "# %l:%c ",
	})
end
o.statusline = "%!v:lua.uk_status()"

-- Floats: the fuzzy finder and the terminal ----------------------------------
local function float(buf, title, w, h, enter, row)
	w, h = math.min(w, vim.o.columns - 4), math.min(h, vim.o.lines - 4)
	return api.nvim_open_win(buf, enter, {
		relative = "editor", width = w, height = h, style = "minimal", border = "rounded",
		row = row or math.floor((vim.o.lines - h) / 2) - 1, col = math.floor((vim.o.columns - w) / 2),
		title = title and (" " .. title .. " ") or nil, title_pos = title and "left" or nil,
	})
end

--- A list filtered as you type (Neovim's matchfuzzypos): Enter picks, Esc closes.
local function pick(title, items, choose)
	local w, lh = 72, math.max(1, math.min(#items, vim.o.lines - 10, 16))
	local top = math.floor((vim.o.lines - lh - 5) / 2)
	local pbuf, lbuf = api.nvim_create_buf(false, true), api.nvim_create_buf(false, true)
	local pw = float(pbuf, title, w, 1, true, top)
	local lw = float(lbuf, nil, w, lh, false, top + 3)
	api.nvim_buf_set_extmark(pbuf, ns, 0, 0, { virt_text = { { "❯ ", "UkKey" } }, virt_text_pos = "inline", right_gravity = false })
	local shown, sel = items, 1
	local function draw()
		local q = api.nvim_buf_get_lines(pbuf, 0, 1, false)[1]
		local pos
		if q == "" then shown = items else
			local r = vim.fn.matchfuzzypos(items, q)
			shown, pos = r[1], r[2]
		end
		sel = math.max(1, math.min(sel, #shown))
		api.nvim_buf_set_lines(lbuf, 0, -1, false, vim.tbl_map(function(s) return "  " .. s end, shown))
		api.nvim_buf_clear_namespace(lbuf, ns, 0, -1)
		for i, p in ipairs(pos or {}) do
			for _, ch in ipairs(p) do
				local b = vim.fn.byteidx(shown[i], ch)
				pcall(api.nvim_buf_set_extmark, lbuf, ns, i - 1, b + 2, { end_col = b + 3, hl_group = "UkKey" })
			end
		end
		if shown[sel] then
			api.nvim_buf_set_extmark(lbuf, ns, sel - 1, 0, { virt_text = { { "❯", "UkKey" } }, virt_text_pos = "overlay", line_hl_group = "PmenuSel" })
			api.nvim_win_set_cursor(lw, { sel, 0 })
		end
		api.nvim_win_set_config(lw, { footer = (" %d/%d "):format(#shown, #items), footer_pos = "right" })
	end
	local function close()
		vim.cmd.stopinsert()
		pcall(api.nvim_win_close, pw, true)
		pcall(api.nvim_win_close, lw, true)
	end
	local function map(k, f) vim.keymap.set("i", k, f, { buffer = pbuf, nowait = true }) end
	local function move(d) return function() sel = (sel - 1 + d) % math.max(#shown, 1) + 1 draw() end end
	map("<Esc>", close)
	map("<CR>", function()
		local it = shown[sel]
		close()
		if it then vim.schedule(function() choose(it) end) end
	end)
	for _, k in ipairs({ "<Down>", "<C-n>", "<Tab>" }) do map(k, move(1)) end
	for _, k in ipairs({ "<Up>", "<C-p>", "<S-Tab>" }) do map(k, move(-1)) end
	api.nvim_create_autocmd("TextChangedI", { buffer = pbuf, callback = function() sel = 1 draw() end })
	api.nvim_create_autocmd("WinLeave", { buffer = pbuf, once = true, callback = close })
	draw()
	vim.cmd.startinsert()
end

local function edit(f) vim.cmd.edit(vim.fn.fnameescape(f)) end

local function files()
	local out = {}
	for name, kind in vim.fs.dir(".", { depth = 5, skip = function(d) return not d:match("^%.") end }) do
		if kind == "file" and not name:match("^%.") and not name:match("/%.") then out[#out + 1] = name end
	end
	table.sort(out)
	pick("Files", out, edit)
end

local function recent()
	local out = vim.tbl_filter(function(f) return vim.uv.fs_stat(f) ~= nil end, vim.v.oldfiles)
	pick("Recent files", vim.tbl_map(function(f) return vim.fn.fnamemodify(f, ":~:.") end, out), edit)
end

local function buffers()
	local out = {}
	for _, b in ipairs(api.nvim_list_bufs()) do
		local name = api.nvim_buf_get_name(b)
		if vim.bo[b].buflisted and name ~= "" then out[#out + 1] = vim.fn.fnamemodify(name, ":~:.") end
	end
	pick("Buffers", out, edit)
end

local term = {}
local function terminal()
	if term.win and api.nvim_win_is_valid(term.win) then return api.nvim_win_hide(term.win) end
	local new = not (term.buf and api.nvim_buf_is_valid(term.buf))
	if new then term.buf = api.nvim_create_buf(false, true) end
	term.win = float(term.buf, "terminal · Ctrl-\\ hides it", math.floor(vim.o.columns * 0.85), math.floor(vim.o.lines * 0.75), true)
	if new then
		vim.fn.jobstart({ vim.o.shell }, { term = true, on_exit = function()
			vim.schedule(function()
				pcall(api.nvim_win_close, term.win, true)
				pcall(api.nvim_buf_delete, term.buf, { force = true })
			end)
		end })
	end
	vim.cmd.startinsert()
end

-- The Space menu: typed quickly, Space f just runs; after a pause, a panel
-- lists the keys and the next key picks one. The start screen lists them too.
local home
local MENU = {
	{ "f", "Find files", files },
	{ "r", "Recent files", recent },
	{ "b", "Buffers", buffers },
	{ "e", "File tree", function() vim.cmd("Lexplore") end },
	{ "t", "Terminal", terminal },
	{ "w", "Save", function() vim.cmd.write() end },
	{ "s", "Edit this config", function() edit(vim.fn.stdpath("config") .. "/init.lua") end },
	{ "h", "Home", function() home() end },
	{ "q", "Quit", function() vim.cmd("confirm qa") end },
}

vim.keymap.set("n", "<Space>", function()
	local win
	if not vim.wait(400, function() return vim.fn.getchar(1) ~= 0 end, 10) then
		local buf = api.nvim_create_buf(false, true)
		api.nvim_buf_set_lines(buf, 0, -1, false, vim.tbl_map(function(m) return (" %s  %s"):format(m[1], m[2]) end, MENU))
		for i = 1, #MENU do api.nvim_buf_set_extmark(buf, ns, i - 1, 1, { end_col = 2, hl_group = "UkKey" }) end
		win = api.nvim_open_win(buf, false, {
			relative = "editor", anchor = "SE", row = vim.o.lines - 2, col = vim.o.columns - 1, width = 24, height = #MENU,
			style = "minimal", border = "rounded", title = " space ", focusable = false, zindex = 150,
		})
		vim.cmd.redraw()
	end
	local ok, key = pcall(vim.fn.getcharstr)
	if win then pcall(api.nvim_win_close, win, true) end
	for _, m in ipairs(MENU) do
		if ok and m[1] == key then return m[3]() end
	end
end)

-- The start screen -----------------------------------------------------------
local LOGO = {
	"███╗   ██╗██╗   ██╗██╗███╗   ███╗",
	"████╗  ██║██║   ██║██║████╗ ████║",
	"██╔██╗ ██║██║   ██║██║██╔████╔██║",
	"██║╚██╗██║╚██╗ ██╔╝██║██║╚██╔╝██║",
	"██║ ╚████║ ╚████╔╝ ██║██║ ╚═╝ ██║",
	"╚═╝  ╚═══╝  ╚═══╝  ╚═╝╚═╝     ╚═╝",
}

function home()
	local buf = api.nvim_create_buf(false, true)
	api.nvim_win_set_buf(0, buf)
	vim.bo[buf].bufhidden = "wipe"
	for k, v in pairs({ number = false, relativenumber = false, cursorline = false, list = false, signcolumn = "no" }) do
		vim.opt_local[k] = v
	end
	local W, H = api.nvim_win_get_width(0), api.nvim_win_get_height(0)
	local logo = W >= 40 and H >= 24 and LOGO or { "N E O V I M" }
	local v, u = vim.version(), vim.uv.os_uname()
	local body = vim.list_extend(vim.deepcopy(logo), {
		"", ("Neovim %d.%d.%d · %s %s · %s"):format(v.major, v.minor, v.patch, u.sysname, u.release:match("^[%d.]+"), u.machine),
		"running in WebAssembly, in this browser tab", "",
	})
	for _, m in ipairs(MENU) do body[#body + 1] = ("%s   %-18s"):format(m[1], m[2]) end
	local lines = {}
	for _ = 1, math.max(0, math.floor((H - #body) / 2)) do lines[#lines + 1] = "" end
	local top = #lines
	for _, l in ipairs(body) do
		lines[#lines + 1] = string.rep(" ", math.max(0, math.floor((W - vim.fn.strdisplaywidth(l)) / 2))) .. l
	end
	api.nvim_buf_set_lines(buf, 0, -1, false, lines)
	vim.bo[buf].modifiable = false
	for i, l in ipairs(logo) do
		local row = top + i - 1
		local col = #lines[row + 1]:match("^ *")
		local chars = vim.fn.split(l, "\\zs")
		for j, ch in ipairs(chars) do
			if ch ~= " " then
				api.nvim_buf_set_extmark(buf, ns, row, col, { end_col = col + #ch, hl_group = "UkLogo" .. math.floor((j - 1) / #chars * 8) })
			end
			col = col + #ch
		end
	end
	for i = #logo + 1, #logo + 3 do
		api.nvim_buf_set_extmark(buf, ns, top + i - 1, 0, { line_hl_group = "UkFaint" })
	end
	for i, m in ipairs(MENU) do
		local row = top + #logo + 4 + i - 1
		local col = #lines[row + 1]:match("^ *")
		api.nvim_buf_set_extmark(buf, ns, row, col, { end_col = col + 1, hl_group = "UkKey" })
		vim.keymap.set("n", m[1], m[3], { buffer = buf, nowait = true })
	end
end

-- Autocommands and the other keys --------------------------------------------
local au = api.nvim_create_autocmd
au("VimEnter", { once = true, callback = function()
	if vim.fn.argc() == 0 and api.nvim_buf_get_name(0) == "" and not vim.bo.modified then home() end
end })
-- Tree-sitter highlighting wherever Neovim has the grammar.
au("FileType", { callback = function(ev) pcall(vim.treesitter.start, ev.buf) end })
au("TextYankPost", { callback = function() (vim.hl or vim.highlight).on_yank({ timeout = 180 }) end })
au("ModeChanged", { callback = function() vim.cmd.redrawstatus() end })

vim.keymap.set("n", "<C-p>", files)
vim.keymap.set({ "n", "t" }, "<C-\\>", terminal)
vim.keymap.set("n", "<Tab>", "<Cmd>bnext<CR>")
vim.keymap.set("n", "<S-Tab>", "<Cmd>bprevious<CR>")
vim.keymap.set("n", "<Esc>", "<Cmd>nohlsearch<CR>")
`;

const README = `# Neovim on unkernel

Neovim, the distro's aarch64 build, on Linux compiled to
WebAssembly, in this browser tab. The setup is one file with no plugins:
config/nvim/init.lua (Space s opens it).

Press Space and wait: a panel lists the keys.

- Space f or Ctrl-P: find a file
- Space e: the file tree
- Space t or Ctrl-\\: a terminal
- Tab, Shift-Tab: the next or previous buffer

Open hello.c or the config: the highlighting is tree-sitter's.
:Tutor teaches Vim itself.
`;

const HELLO = `#include <stdio.h>
#include <sys/utsname.h>

/* Compiled for aarch64, run by the kernel in this tab. */
int main(void)
{
	struct utsname u;

	if (uname(&u) != 0)
		return 1;
	printf("Hello from %s %s on %s\\n", u.sysname, u.release, u.machine);
	return 0;
}
`;

export default {
	id: "nvim",
	title: "Neovim",
	desc: "Neovim with a start screen, fuzzy finder, terminal and tree-sitter, from one plugin-free config",
	// A stylised N (not Neovim's logo).
	icon: { svg: '<path d="M4 3.5h3.6l8.8 11.7V3.5H20v17h-3.6L7.6 8.8v11.7H4Z"/><path opacity=".55" d="M4 3.5h3.6v17H4Z"/>' },
	colors: ["#45d483", "#0b3a5c"],
	needs: { net: true },
	community: true,
	files: {
		"config/nvim/init.lua": INIT,
		"README.md": README,
		"hello.c": HELLO,
	},
	packages: { alpine: ["neovim"], arch: ["neovim"], debian: ["neovim"] },
	terminal: "window",
	commands: ['XDG_CONFIG_HOME="$PWD/config" nvim'],
} satisfies TerminalApp;
