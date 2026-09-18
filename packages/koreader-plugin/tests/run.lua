-- Standalone Lua tests for the plugin's pure modules (no KOReader required).
-- Run with: luajit tests/run.lua  (from packages/koreader-plugin)

local here = debug.getinfo(1, "S").source:match("@(.*/)") or ""
local plugin = here .. "../plugin/studyreader.koplugin/"

local failures = 0
local function check(name, fn)
	local ok, err = pcall(fn)
	if ok then
		print("  ok  " .. name)
	else
		failures = failures + 1
		print("FAIL  " .. name .. "\n      " .. tostring(err))
	end
end

dofile(plugin .. "srs.lua")
dofile(plugin .. "md2xhtml.lua")

local md2xhtml = dofile(plugin .. "md2xhtml.lua")
local SRS = dofile(plugin .. "srs.lua")

check("md2xhtml renders headings, tables, quotes, directives", function()
	local md = table.concat({
		"# Título",
		"",
		"Parágrafo com **negrito** e *itálico* e `code`.",
		"",
		"## Seção",
		"",
		"| A | B |",
		"| - | - |",
		"| 1 | 2 |",
		"",
		"> Aviso importante",
		"",
		"{{quiz:q1}}",
		"",
		"{{image:assets/x.jpg}}",
		"",
		"- item 1",
		"- item 2",
		"",
		"```",
		"code block",
		"```",
	}, "\n")
	local out = md2xhtml.convert(md, "Teste")
	assert(out.xhtml:match("<h1"), "h1")
	assert(out.xhtml:match("<h2[^>]*>Seção</h2>"), "h2")
	assert(out.xhtml:match("<strong>negrito</strong>"), "bold")
	assert(out.xhtml:match("<em>itálico</em>"), "italic")
	assert(out.xhtml:match("<code>code</code>"), "inline code")
	assert(out.xhtml:match("<table"), "table")
	assert(out.xhtml:match("<th[^>]*>A</th>"), "th A")
	assert(out.xhtml:match("<blockquote"), "blockquote")
	assert(out.xhtml:match("Quiz"), "quiz marker")
	assert(out.xhtml:match('src="assets/x%.jpg"') or out.xhtml:match('src="assets/x.jpg"'), "image src")
	assert(out.xhtml:match("<li>item 1</li>"), "list item")
	assert(out.xhtml:match("<pre"), "code fence")
	assert(not out.xhtml:match("{{"), "no leaked directives")
	assert(#out.quizzes == 1 and out.quizzes[1] == "q1", "quiz ids")
	assert(#out.images == 1 and out.images[1] == "assets/x.jpg", "image ids")
end)

check("md2xhtml escapes XML", function()
	local out = md2xhtml.convert("a < b & c > d", "T")
	assert(out.xhtml:match("&lt;"), "lt")
	assert(out.xhtml:match("&amp;"), "amp")
end)

check("md2xhtml keeps escaped punctuation literal", function()
	local out = md2xhtml.convert("a \\_b\\_ c", "T")
	assert(out.xhtml:match("<p>a _b_ c</p>"), "literal underscores, got: "
		.. (out.xhtml:match("<p>a (.-)</p>") or "?"))
end)

check("srs schedules SM-2 intervals", function()
	local card = SRS.newCard(1000)
	assert(SRS.isDue(card, 1000))
	SRS.grade(card, 4, 1000)
	assert(card.interval == 1)
	SRS.grade(card, 4, 2000)
	assert(card.interval == 6)
	SRS.grade(card, 5, 3000)
	assert(card.interval >= 14)
	assert(not SRS.isDue(card, 4000))
	SRS.grade(card, 1, 4000)
	assert(card.due == 4600 and card.lapses == 1 and card.reps == 0)
end)

check("srs clamps easiness floor", function()
	local card = SRS.newCard(0)
	for _ = 1, 20 do
		SRS.grade(card, 3, 0)
	end
	assert(card.ef >= 1.3)
end)

check("main registers itself in the KOReader main menu", function()
	-- FileManagerMenu/ReaderMenu only call addToMainMenu() on widgets passed to
	-- menu:registerToMainMenu(), so init() must register the plugin.
	local stubs = {
		["dispatcher"] = { registerAction = function() end },
		["ui/uimanager"] = { scheduleIn = function() end },
		["logger"] = { dbg = function() end, info = function() end },
		["gettext"] = function(s) return s end,
		["screens"] = {},
		["state"] = {},
		["store"] = {},
		["ui/widget/container/widgetcontainer"] = {
			extend = function(base, o)
				o = o or {}
				o.new = function(cls, inst)
					inst = setmetatable(inst or {}, { __index = cls })
					if inst.init then inst:init() end
					return inst
				end
				return setmetatable(o, { __index = base })
			end,
		},
	}
	local saved = {}
	for name, mod in pairs(stubs) do
		saved[name] = package.loaded[name]
		package.loaded[name] = mod
	end
	local ok, err = pcall(function()
		local Plugin = dofile(plugin .. "main.lua")
		local registered = {}
		local ui = { menu = { registerToMainMenu = function(_, w) registered[#registered + 1] = w end } }
		local instance = Plugin:new{ ui = ui }
		assert(#registered == 1 and registered[1] == instance, "plugin not registered to main menu")
		local menu_items = {}
		instance:addToMainMenu(menu_items)
		local entry = menu_items.studyreader
		assert(entry and entry.text == "Study", "missing Study entry")
		local sub = entry.sub_item_table_func()
		assert(sub[1].text == "My courses" and sub[2].text == "Continue studying"
			and sub[3].text == "Reviews", "unexpected Study submenu")
	end)
	for name in pairs(stubs) do
		package.loaded[name] = saved[name]
	end
	assert(ok, err)
end)

check("state treats timestamped lessons as completed", function()
	local stubs = {
		["datastorage"] = { getDataDir = function() return "/tmp" end },
		["json"] = {},
		["logger"] = { warn = function() end },
		["libs/libkoreader-lfs"] = {},
	}
	local saved = {}
	for name, mod in pairs(stubs) do
		saved[name] = package.loaded[name]
		package.loaded[name] = mod
	end
	local ok, err = pcall(function()
		local State = dofile(plugin .. "state.lua")
		local state = { progress = {}, answers = {}, reviews = {} }
		assert(not State.completedLesson(state, "l1"), "fresh lesson completed")
		State.markLessonDone(state, "l1")
		assert(State.completedLesson(state, "l1"), "markLessonDone not seen as completed")
		state.progress.completedLessons.legacy = true
		assert(State.completedLesson(state, "legacy"), "legacy boolean entry")
		assert(not State.completedLesson(state, "l2"), "other lesson completed")
	end)
	for name in pairs(stubs) do
		package.loaded[name] = saved[name]
	end
	assert(ok, err)
end)

-- QuizWidget runs against minimal fakes of the KOReader widgets it uses: they
-- only report sizes, which is what the layout logic depends on. The real
-- quiz.lua and state.lua are loaded.
local function withQuizWidget(screen_w, screen_h, fn)
	local function extend(base, o)
		o = o or {}
		o.new = function(cls, inst)
			inst = setmetatable(inst or {}, { __index = cls })
			if inst.init then inst:init() end
			return inst
		end
		o.extend = extend
		return setmetatable(o, { __index = base })
	end
	local function widget(get_size)
		return extend({}, { getSize = get_size })
	end
	local function lineHeight(face) return math.floor(face.size * 1.4) end
	local ScrollableContainer = widget(function(self) return self.dimen end)
	function ScrollableContainer:getScrollbarWidth() return 18 end
	function ScrollableContainer:getScrolledOffset()
		return { x = 0, y = self.offset_y or 0 }
	end
	function ScrollableContainer:setScrolledOffset(p) self.offset_y = p.y end
	function ScrollableContainer:onCloseWidget() self.closed = true end
	local VerticalGroup = widget(function(self)
		local w, h = 0, 0
		for _, child in ipairs(self) do
			local size = child:getSize()
			w = math.max(w, size.w)
			h = h + size.h
		end
		return { w = w, h = h }
	end)
	local saves = {}
	local stubs = {
		["ffi/blitbuffer"] = { COLOR_WHITE = 0 },
		["ui/widget/button"] = widget(function(self) return { w = self.width, h = 40 } end),
		["ui/widget/container/centercontainer"] = widget(function(self) return self.dimen end),
		["device"] = {
			screen = { getWidth = function() return screen_w end, getHeight = function() return screen_h end },
			hasKeys = function() return false end,
		},
		["ui/widget/focusmanager"] = extend({}, {
			key_events = {},
			refocusWidget = function() end,
		}),
		["ui/font"] = { getFace = function(_, _, size) return { size = size or 20 } end },
		["ui/widget/container/framecontainer"] = widget(function(self)
			local size = self[1]:getSize()
			return { w = size.w + 2 * self.padding, h = size.h + 2 * self.padding }
		end),
		["ui/geometry"] = { new = function(_, t) return t end },
		["ui/widget/container/scrollablecontainer"] = ScrollableContainer,
		["ui/size"] = { padding = { large = 15, default = 5, small = 2 } },
		["ui/widget/textboxwidget"] = widget(function(self)
			local per_line = math.floor(self.width / (self.face.size * 0.5))
			local lines = 0
			for paragraph in (self.text .. "\n"):gmatch("(.-)\n") do
				lines = lines + math.max(1, math.ceil(#paragraph / per_line))
			end
			return { w = self.width, h = lines * lineHeight(self.face) }
		end),
		["ui/widget/textwidget"] = widget(function(self)
			return { w = self.max_width, h = lineHeight(self.face) }
		end),
		["ui/widget/titlebar"] = extend(widget(function(self) return { w = self.width, h = 80 } end),
			{ getHeight = function() return 80 end }),
		["ui/uimanager"] = { setDirty = function() end, close = function() end },
		["ui/widget/verticalgroup"] = VerticalGroup,
		["ui/widget/verticalspan"] = widget(function(self) return { w = 0, h = self.width } end),
		["gettext"] = function(s) return s end,
		["datastorage"] = { getDataDir = function() return "/tmp" end },
		["json"] = {},
		["logger"] = { warn = function() end },
		["libs/libkoreader-lfs"] = {},
	}
	local saved = {}
	for name, mod in pairs(stubs) do
		saved[name] = package.loaded[name]
		package.loaded[name] = mod
	end
	saved.state = package.loaded.state
	local ok, err = pcall(function()
		local State = dofile(plugin .. "state.lua")
		State.save = function(course_id, state) saves[#saves + 1] = { course_id, state } end
		package.loaded.state = State
		local QuizWidget = dofile(plugin .. "quiz.lua")
		fn(QuizWidget, saves)
	end)
	for name in pairs(stubs) do
		package.loaded[name] = saved[name]
	end
	package.loaded.state = saved.state
	assert(ok, err)
end

local function quizButtons(w)
	local found = {}
	local function walk(node)
		if type(node) ~= "table" then return end
		if node.callback and node.text then found[#found + 1] = node end
		for _, child in ipairs(node) do walk(child) end
	end
	walk(w.cropping_widget)
	return found
end

local function buttonTexts(w)
	local texts = {}
	for _, button in ipairs(quizButtons(w)) do texts[#texts + 1] = button.text end
	return table.concat(texts, " | ")
end

local function newQuiz(QuizWidget, question)
	return QuizWidget:new{
		course = { id = "c1", questions = { q1 = question } },
		lesson = { id = "l1", title = "Lesson" },
		question_ids = { "q1" },
		state = { progress = {}, answers = {}, reviews = {} },
	}
end

local long_statement = {}
for i = 1, 28 do
	long_statement[i] = string.rep("Enunciado longo da questão real. ", 2) .. i
end
local LONG_QUESTION = {
	type = "single-choice",
	question = table.concat(long_statement, "\n"),
	options = {
		{ id = "A", text = string.rep("alternativa A ", 8) },
		{ id = "B", text = string.rep("alternativa B ", 8) },
		{ id = "C", text = string.rep("alternativa C ", 8) },
		{ id = "D", text = string.rep("alternativa D ", 8) },
		{ id = "E", text = string.rep("alternativa E ", 8) },
	},
	correct = { "C" },
}

check("quiz: long question scrolls inside a viewport below a fixed title", function()
	withQuizWidget(600, 800, function(QuizWidget)
		local w = newQuiz(QuizWidget, LONG_QUESTION)
		local view = w.cropping_widget
		assert(view, "no cropping_widget (ScrollableContainer)")
		local outer = w[1][1]
		assert(outer[1].title == "Lesson", "title bar is not fixed above the body")
		assert(outer[2] == view, "body is not the scrollable container")
		-- viewport = screen height - title bar - frame padding (top+bottom)
		assert(view.dimen.h == 800 - 80 - 2 * 15, "viewport height " .. view.dimen.h)
		assert(view.show_parent == w, "show_parent")
		local content = view[1]:getSize()
		assert(content.h > view.dimen.h, "long question should overflow the viewport")
		assert(content.w <= view.dimen.w - 18, "content must leave room for the scrollbar")
		local buttons = quizButtons(w)
		assert(#buttons == 5, "all options inside the scrollable body: " .. buttonTexts(w))
		assert(buttons[5].text:match("^☐ E%)"), "last option E present")
		assert(w[1]:getSize().h <= 800, "widget taller than the screen")
	end)
end)

check("quiz: short question fits without scrolling width loss", function()
	withQuizWidget(600, 800, function(QuizWidget)
		local w = newQuiz(QuizWidget, {
			type = "single-choice",
			question = "Julgue o item.",
			options = { { id = "C", text = "Certo" }, { id = "E", text = "Errado" } },
			correct = { "E" },
		})
		local view = w.cropping_widget
		assert(view[1]:getSize().h <= view.dimen.h, "short question should fit")
		local buttons = quizButtons(w)
		assert(#buttons == 2, buttonTexts(w))
		assert(buttons[1].width == view.dimen.w, "short question keeps full width")
	end)
end)

check("quiz: answering records state and each screen starts at the top", function()
	withQuizWidget(600, 800, function(QuizWidget, saves)
		local w = newQuiz(QuizWidget, LONG_QUESTION)
		local question_view = w.cropping_widget
		question_view.offset_y = 1234 -- user scrolled down to the options
		w:onOption("A")
		assert(w.state.answers.q1 and w.state.answers.q1.correct == false, "answer not recorded")
		assert(w.state.answers.q1.selected[1] == "A", "selected option")
		assert(#saves == 1 and saves[1][1] == "c1", "state not saved")
		assert(w.mode == "feedback", "no feedback")
		assert(w.cropping_widget ~= question_view, "feedback reuses the question view")
		assert(question_view.closed, "old view buffer not released")
		assert((w.cropping_widget.offset_y or 0) == 0, "feedback not at the top")
		assert(buttonTexts(w) == "See results", buttonTexts(w))
		w.cropping_widget.offset_y = 50
		w:onFinish()
		assert(w.mode == "summary", "no summary")
		assert((w.cropping_widget.offset_y or 0) == 0, "summary not at the top")
		assert(w.state.progress.completedLessons.l1, "lesson not completed")
		assert(#saves == 2, "completion not saved")
	end)
end)

check("quiz: multiple-choice toggles keep the scroll position", function()
	withQuizWidget(600, 800, function(QuizWidget)
		local question = {}
		for k, v in pairs(LONG_QUESTION) do question[k] = v end
		question.type = "multiple-choice"
		question.correct = { "A", "C" }
		local w = newQuiz(QuizWidget, question)
		w.cropping_widget.offset_y = 900
		w:onOption("A")
		assert(w.cropping_widget.offset_y == 900, "toggle jumped away from the options")
		assert(quizButtons(w)[1].text:match("^☑ A%)"), "toggle not shown")
		assert(buttonTexts(w):match("Confirm$"), "Confirm reachable in the body")
		w:onOption("C")
		w:onConfirm()
		assert(w.state.answers.q1.correct == true, "multiple-choice grading")
		assert((w.cropping_widget.offset_y or 0) == 0, "feedback not at the top")
	end)
end)

if failures > 0 then
	print(string.format("\n%d failure(s)", failures))
	os.exit(1)
end
print("\nall plugin tests passed")
