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
local function withStudyWidget(module_name, screen_w, screen_h, fn)
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
	local HorizontalGroup = widget(function(self)
		local w, h = 0, 0
		for _, child in ipairs(self) do
			local size = child:getSize()
			w = w + size.w
			h = math.max(h, size.h)
		end
		return { w = w, h = h }
	end)
	local saves = {}
	local shown = {}
	local stubs = {
		["ffi/blitbuffer"] = { COLOR_WHITE = 0, COLOR_BLACK = 1, COLOR_DARK_GRAY = 2, COLOR_LIGHT_GRAY = 3 },
		["ui/widget/button"] = widget(function(self) return { w = self.width, h = 40 } end),
		["ui/widget/horizontalgroup"] = HorizontalGroup,
		["ui/widget/horizontalspan"] = widget(function(self) return { w = self.width, h = 0 } end),
		["ui/widget/linewidget"] = widget(function(self) return self.dimen end),
		["ui/widget/infomessage"] = widget(function() return { w = 0, h = 0 } end),
		["ui/widget/container/inputcontainer"] = extend({}, { key_events = {} }),
		["ui/gesturerange"] = { new = function(_, t) return t end },
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
			local inset = (self.padding or 0) + (self.bordersize or 0)
			return { w = self.width or (size.w + 2 * inset), h = size.h + 2 * inset }
		end),
		["ui/geometry"] = { new = function(_, t) return t end },
		["ui/widget/container/scrollablecontainer"] = ScrollableContainer,
		["ui/size"] = { padding = { large = 15, default = 5, small = 2, button = 4 }, line = { thin = 1, medium = 2, thick = 3 }, border = { button = 2 } },
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
		["ui/uimanager"] = { setDirty = function() end, close = function() end, show = function(_, w) shown[#shown + 1] = w end },
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
	saved.srs = package.loaded.srs
	saved.present = package.loaded.present
	local ok, err = pcall(function()
		local State = dofile(plugin .. "state.lua")
		State.save = function(course_id, state) saves[#saves + 1] = { course_id, state } end
		package.loaded.state = State
		package.loaded.srs = dofile(plugin .. "srs.lua")
		package.loaded.present = dofile(plugin .. "present.lua")
		local Widget = dofile(plugin .. module_name)
		fn(Widget, saves, shown)
	end)
	for name in pairs(stubs) do
		package.loaded[name] = saved[name]
	end
	package.loaded.state = saved.state
	package.loaded.srs = saved.srs
	package.loaded.present = saved.present
	assert(ok, err)
end

local function withQuizWidget(screen_w, screen_h, fn)
	withStudyWidget("quiz.lua", screen_w, screen_h, fn)
end

local function withReviewWidget(screen_w, screen_h, fn)
	withStudyWidget("review.lua", screen_w, screen_h, fn)
end

local function walkWidgets(root, fn)
	local function walk(node)
		if type(node) ~= "table" then return end
		fn(node)
		for _, child in ipairs(node) do walk(child) end
	end
	walk(root)
end

local function quizButtons(w)
	local found = {}
	walkWidgets(w.cropping_widget or w[1], function(node)
		if node.callback and node.text then found[#found + 1] = node end
	end)
	return found
end

local function allTexts(root)
	local texts = {}
	walkWidgets(root, function(node)
		if type(node.text) == "string" then texts[#texts + 1] = node.text end
	end)
	return table.concat(texts, "\n")
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
		assert(buttonTexts(w) == "VER RESULTADO", buttonTexts(w))
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
		assert(buttonTexts(w):match("Confirmar$"), "Confirm reachable in the body")
		w:onOption("C")
		w:onConfirm()
		assert(w.state.answers.q1.correct == true, "multiple-choice grading")
		assert((w.cropping_widget.offset_y or 0) == 0, "feedback not at the top")
	end)
end)

local Present = dofile(plugin .. "present.lua")

local function sampleCourse()
	return {
		id = "indio-revisao",
		manifest = {
			title = "ÍNDIO REVISÃO — Livro de Erros",
			modules = {
				{ id = "trib", title = "Direito Tributário", lessons = {
					{ id = "error-111", title = "Competência · Q111", content = "content/error-111.md" },
					{ id = "error-222", title = "Imunidades · Q222", content = "content/error-222.md" },
				} },
				{ id = "cont", title = "Contabilidade Geral", lessons = {
					{ id = "error-333", title = "Ativo · Q333", content = "content/error-333.md" },
				} },
			},
			extensions = { indio = { priorities = {
				["111"] = { priority = "CRITICAL", rule = "relapse-unrecovered", errorCount = 3, daysSinceLastError = 2,
					priorityReasons = { "voltou a errar após acerto, sem recuperação consistente", "3 erros registrados" },
					study = { signal = "LAPSING", reviewLapses = 1 } },
				["222"] = { priority = "HIGH", errorCount = 2, daysSinceLastError = 10, priorityReasons = { "erro recorrente" } },
			} } },
		},
	}
end

check("present: progress bar and badges are deterministic and never invent data", function()
	assert(Present.bar(0, 10, 10) == string.rep("░", 10), "empty bar")
	assert(Present.bar(3, 10, 10) == string.rep("█", 3) .. string.rep("░", 7), "3/10 bar")
	assert(Present.bar(10, 10, 10) == string.rep("█", 10), "full bar")
	assert(Present.bar(1, 0, 10) == string.rep("░", 10), "zero total")
	assert(Present.priorityBadge("CRITICAL") == "[CRITICAL]", "priority badge")
	assert(Present.priorityBadge("weird") == nil and Present.priorityBadge(nil) == nil, "unknown priority")
	assert(Present.signalBadge("LAPSING") == "[LAPSING]" and Present.signalBadge("nope") == nil, "signal badge")
end)

check("present: lesson metadata comes only from the manifest priorities", function()
	local course = sampleCourse()
	local meta = Present.lessonMeta(course, course.manifest.modules[1].lessons[1])
	assert(meta and meta.key == "111" and meta.priority == "CRITICAL" and meta.signal == "LAPSING", "meta 111")
	assert(#meta.reasons == 2, "reasons carried")
	local partial = Present.lessonMeta(course, course.manifest.modules[1].lessons[2])
	assert(partial.priority == "HIGH" and partial.signal == nil, "no signal when absent")
	assert(Present.lessonMeta(course, course.manifest.modules[2].lessons[1]) == nil, "unknown lesson → nil")
	assert(Present.lessonMeta({ manifest = {} }, { id = "error-111" }) == nil, "course without priorities → nil")
end)

check("present: course, module and lesson menu items carry a readable second line", function()
	local item = Present.courseItem("ÍNDIO REVISÃO — Livro de Erros",
		{ lessons = 30, done = 2, quizzes = 30, answered = 4, due = 29, active = true })
	assert(item.text:match("^ÍNDIO REVISÃO — Livro de Erros  —  "), "title first, meta after (Menu strips newlines)")
	assert(item.text:match("2/30 aulas"), "lesson progress")
	assert(item.text:match("29 reviews"), "due reviews")
	assert(not item.text:match("\n"), "no newline in menu text")
	assert(item.mandatory == "6%", "percent")
	assert(item.bold == true, "active course is bold")
	local finished = Present.courseItem("INDIO Error Test", { lessons = 1, done = 1, quizzes = 1, answered = 1, due = 0, active = false })
	assert(finished.mandatory == "100%" and finished.mandatory_dim == true and not finished.bold, "finished course is dimmed")
	assert(finished.text:match("concluído"), "finished status")

	local module = Present.moduleItem("Direito Tributário", { lessons = 6, done = 1 }, { CRITICAL = 5, HIGH = 1 })
	assert(module.text:match("^Direito Tributário  —  1/6 aulas"), "module title and progress")
	assert(module.text:match("5 CRITICAL") and module.text:match("1 HIGH"), "module priority counts")
	assert(module.mandatory == "16%", "module percent")


	local course = sampleCourse()
	local lesson = Present.lessonItem(course.manifest.modules[1].lessons[1], true,
		{ total = 1, answered = 1, correct = false }, Present.lessonMeta(course, course.manifest.modules[1].lessons[1]))
	assert(lesson.text:match("^✓ %[CRITICAL%] %[LAPSING%] Competência · Q111"), "mark and badges lead the title")
	local unseen = Present.lessonItem({ id = "error-9", title = "T · Q9" }, false, nil, { priority = "MEDIUM", signal = "UNSEEN", reasons = {} })
	assert(unseen.text == "○ [MEDIUM] T · Q9", "UNSEEN is the default state and is not badged in lists")
	assert(lesson.text:match("3 erros · há 2 dias"), "history summary from metadata")
	assert(lesson.mandatory == "✗ 1/1", "wrong quiz in the right column")
	local pending = Present.lessonItem(course.manifest.modules[2].lessons[1], false, { total = 1, answered = 0 }, nil)
	assert(pending.text == "○ Ativo · Q333", "pending lesson without metadata")
	assert(pending.mandatory == "0/1" and pending.mandatory_dim == true, "pending quiz dimmed")
	local right = Present.lessonItem(course.manifest.modules[1].lessons[2], true, { total = 1, answered = 1, correct = true },
		Present.lessonMeta(course, course.manifest.modules[1].lessons[2]))
	assert(right.text:match("^✓ %[HIGH%] Imunidades") and right.mandatory == "✓ 1/1", "correct quiz")
end)

check("present: lesson panel renders a review header with badges and answers", function()
	local course = sampleCourse()
	local html = Present.lessonPanel({
		materia = "Direito Tributário",
		assunto = "Competência",
		question_id = "111",
		meta = Present.lessonMeta(course, course.manifest.modules[1].lessons[1]),
		statement = "Enunciado da questão sintética.",
		marked = "D) alternativa marcada",
		correct = "B) alternativa correta",
		quiz = { answered = true, correct = false },
	})
	assert(html:match('class="sr%-statement"') and html:match("Enunciado da questão sintética%."), "statement in panel")
	assert(html:match('class="sr%-panel"'), "panel container")
	assert(html:match("Direito Tributário") and html:match("Competência"), "materia/assunto")
	assert(html:match("Q111"), "question id")
	assert(html:match('class="sr%-badge sr%-p%-critical"') and html:match(">CRITICAL<"), "priority badge class")
	assert(html:match('class="sr%-badge sr%-s%-lapsing"') and html:match(">LAPSING<"), "signal badge class")
	assert(html:match("alternativa marcada") and html:match("alternativa correta"), "answers")
	assert(html:match("3 erros registrados"), "reasons listed")
	assert(html:match("quiz") and html:match("errado"), "quiz status")
	local bare = Present.lessonPanel({ materia = "X", assunto = nil, question_id = nil, meta = nil })
	assert(bare:match('class="sr%-panel"') and not bare:match("sr%-badge"), "panel without metadata has no badges")
	assert(Present.panelCss():match("%.sr%-badge"), "css exported")
end)

check("md2xhtml accepts a prepended panel, extra css and skips leading title headings", function()
	local md = "# Matéria\n\n## Assunto\n\n### O erro\n\nTexto.\n"
	local out = md2xhtml.convert(md, "T", "", { prepend = '<div class="sr-panel">P</div>', extra_css = ".sr-panel{}", skip_leading_headings = true })
	assert(out.xhtml:match('<div class="sr%-panel">P</div>'), "prepended panel")
	assert(out.xhtml:match("%.sr%-panel{}"), "extra css")
	assert(not out.xhtml:match("<h1") and not out.xhtml:match("<h2"), "leading h1/h2 skipped")
	assert(out.xhtml:match("<h3[^>]*>O erro</h3>"), "h3 kept")
	local plain = md2xhtml.convert(md, "T")
	assert(plain.xhtml:match("<h1"), "default keeps headings")

	local with_priority = table.concat({
		"# M", "", "### O erro", "", "Texto.", "", "### Prioridade", "", "**HIGH**", "", "- razão 1", "",
		"### Explicação", "", "Fim.", "",
	}, "\n")
	local skipped = md2xhtml.convert(with_priority, "T", "", { skip_sections = { ["Prioridade"] = true } })
	assert(not skipped.xhtml:match("Prioridade") and not skipped.xhtml:match("razão 1"), "priority section skipped")
	assert(skipped.xhtml:match("O erro") and skipped.xhtml:match("Explicação") and skipped.xhtml:match("Fim%."), "other sections kept")
end)

local function metaCourse()
	local course = sampleCourse()
	course.id = "c1"
	course.questions = {
		["111-recovery"] = {
			type = "single-choice",
			question = "Enunciado da questão 111.",
			options = { { id = "A", text = "Alternativa A" }, { id = "B", text = "Alternativa B" } },
			correct = { "B" },
			explanation = "Porque B está correta.",
		},
		["333-recovery"] = {
			type = "single-choice",
			question = "Enunciado 333.",
			options = { { id = "C", text = "Certo" }, { id = "E", text = "Errado" } },
			correct = { "E" },
		},
	}
	course.flashcards = {
		{ id = "111-card", front = "Pergunta do card 111?", back = "Resposta do card 111." },
		{ id = "333-card", front = "Pergunta 333?", back = "Resposta 333." },
	}
	return course
end

check("present: quiz header, option labels, feedback and summary texts", function()
	local course = metaCourse()
	local lesson = course.manifest.modules[1].lessons[1]
	local header = Present.quizHeader(course, lesson, "111-recovery", 1, 3)
	assert(header.kicker == "DIREITO TRIBUTÁRIO · Q111", "kicker: " .. tostring(header.kicker))
	assert(header.badges == "[CRITICAL] [LAPSING]", "badges: " .. tostring(header.badges))
	assert(header.counter == "Questão 1 / 3", "counter")
	local bare = Present.quizHeader({ manifest = {} }, { id = "l1", title = "Lesson" }, "q1", 2, 2)
	assert(bare.kicker == "LESSON" and bare.badges == nil and bare.counter == "Questão 2 / 2", "no metadata → no badges, lesson title as kicker")

	assert(Present.optionLabel({ id = "A", text = "Texto" }, false) == "☐ A) Texto", "unselected label")
	assert(Present.optionLabel({ id = "A", text = "Texto" }, true) == "☑ A) Texto", "selected label")

	local wrong = Present.feedbackTexts(course.questions["111-recovery"], { "A" }, false)
	assert(wrong.headline == "✗ INCORRETO", "wrong headline")
	assert(wrong.marked == "A) Alternativa A" and wrong.correct == "B) Alternativa B", "marked/correct with full text")
	assert(wrong.explanation == "Porque B está correta.", "explanation")
	local right = Present.feedbackTexts(course.questions["333-recovery"], { "E" }, true)
	assert(right.headline == "✓ CORRETO" and right.marked == nil and right.correct == nil, "correct feedback hides answers")
	assert(right.explanation == nil, "no explanation is not invented")

	local summary = Present.summaryTexts(1, 1, true)
	assert(summary.title == "REVISÃO CONCLUÍDA" and summary.score == "1 / 1" and summary.percent == "100%", "summary")
	assert(summary.status == "✓ Aula concluída", "lesson done status")
	local partial = Present.summaryTexts(0, 2, false)
	assert(partial.title == "QUIZ CONCLUÍDO" and partial.percent == "0%" and partial.status == nil, "partial summary")
end)

check("present: flashcard metadata comes from the card id and the manifest", function()
	local course = metaCourse()
	local info = Present.cardMeta(course, course.flashcards[1])
	assert(info.materia == "Direito Tributário" and info.badges == "[CRITICAL] [LAPSING]", "card 111 metadata")
	local none = Present.cardMeta(course, course.flashcards[2])
	assert(none.materia == "Contabilidade Geral" and none.badges == nil, "card 333: materia but no priority metadata")
	local orphan = Present.cardMeta(course, { id = "adm-podc-card1" })
	assert(orphan.materia == nil and orphan.badges == nil, "unknown card → nothing")
	assert(Present.ratingLabels()[1] == "Again" and #Present.ratingLabels() == 4, "rating labels")
end)

check("quiz: header shows metadata and the selected option is highlighted", function()
	withQuizWidget(600, 800, function(QuizWidget)
		local course = metaCourse()
		local w = QuizWidget:new{
			course = course,
			lesson = course.manifest.modules[1].lessons[1],
			question_ids = { "111-recovery" },
			state = { progress = {}, answers = {}, reviews = {} },
		}
		local texts = allTexts(w.cropping_widget)
		assert(texts:match("DIREITO TRIBUTÁRIO · Q111"), "kicker missing: " .. texts)
		assert(texts:match("%[CRITICAL%] %[LAPSING%]"), "badges missing")
		assert(texts:match("Questão 1 / 1"), "counter missing")
		assert(texts:match("Enunciado da questão 111%."), "statement missing")
		local buttons = quizButtons(w)
		assert(not buttons[1].frame.invert and not buttons[2].frame.invert, "nothing selected")
		assert(buttons[1].label.text == "☐ A) Alternativa A", "option label")
		assert(buttons[1]:getSize().w == w.cropping_widget.dimen.w, "options span the body width")
	end)
	withQuizWidget(600, 800, function(QuizWidget)
		local question = {}
		for k, v in pairs(LONG_QUESTION) do question[k] = v end
		question.type = "multiple-choice"
		question.correct = { "A", "C" }
		local w = newQuiz(QuizWidget, question)
		w:onOption("C")
		local buttons = quizButtons(w)
		assert(buttons[3].frame.invert == true and buttons[3].text:match("^☑ C%)"), "selected option inverted + checked")
		assert(not buttons[1].frame.invert, "others not inverted")
		buttons[3]:onTapSelect()
		assert(not quizButtons(w)[3].frame.invert, "tap toggles the selection off again")
		assert(buttonTexts(w):match("Confirmar$"), "confirm stays explicit")
	end)
end)

check("quiz: long alternatives wrap instead of shrinking or truncating", function()
	withQuizWidget(600, 800, function(QuizWidget)
		local w = newQuiz(QuizWidget, LONG_QUESTION)
		local option = quizButtons(w)[1]
		assert(option.label.width and option.label.width < 600, "option text is a wrapped TextBoxWidget")
		assert(option:getSize().h > 40, "wrapped option is taller than a one-line button: " .. option:getSize().h)
		assert(option.label.face.size == 22, "option font size is not reduced")
	end)
end)

check("quiz: feedback shows marked vs correct answers, explanation only when present", function()
	withQuizWidget(600, 800, function(QuizWidget)
		local course = metaCourse()
		local w = QuizWidget:new{
			course = course,
			lesson = course.manifest.modules[1].lessons[1],
			question_ids = { "111-recovery" },
			state = { progress = {}, answers = {}, reviews = {} },
		}
		w:onOption("A")
		local texts = allTexts(w.cropping_widget)
		assert(texts:match("✗ INCORRETO"), "incorrect headline")
		assert(texts:match("VOCÊ MARCOU") and texts:match("A%) Alternativa A"), "marked answer")
		assert(texts:match("RESPOSTA CORRETA") and texts:match("B%) Alternativa B"), "correct answer")
		assert(texts:match("EXPLICAÇÃO") and texts:match("Porque B está correta%."), "explanation")
		assert(w.state.answers["111-recovery"].correct == false, "grading unchanged")
	end)
	withQuizWidget(600, 800, function(QuizWidget)
		local course = metaCourse()
		local w = QuizWidget:new{
			course = course,
			lesson = course.manifest.modules[2].lessons[1],
			question_ids = { "333-recovery" },
			state = { progress = {}, answers = {}, reviews = {} },
		}
		w:onOption("E")
		local texts = allTexts(w.cropping_widget)
		assert(texts:match("✓ CORRETO"), "correct headline")
		assert(not texts:match("VOCÊ MARCOU") and not texts:match("EXPLICAÇÃO"), "no answers/explanation block when correct and none exists")
		assert(w.state.answers["333-recovery"].correct == true, "grading unchanged")
	end)
end)

check("quiz: long feedback still scrolls and the summary reports score and completion", function()
	withQuizWidget(600, 800, function(QuizWidget)
		local question = {}
		for k, v in pairs(LONG_QUESTION) do question[k] = v end
		question.explanation = string.rep("Explicação longa da alternativa correta. ", 60)
		local w = newQuiz(QuizWidget, question)
		w:onOption("A")
		local view = w.cropping_widget
		assert(view[1]:getSize().h > view.dimen.h, "long feedback should overflow the viewport")
		assert(view[1]:getSize().w <= view.dimen.w - 18, "feedback leaves room for the scrollbar")
		assert((view.offset_y or 0) == 0, "feedback starts at the top")
		w:onFinish()
		local texts = allTexts(w.cropping_widget)
		assert(texts:match("REVISÃO CONCLUÍDA") or texts:match("QUIZ CONCLUÍDO"), "summary title")
		assert(texts:match("0 / 1") and texts:match("0%%"), "score")
		assert(texts:match("✓ Aula concluída"), "completion status")
		assert(buttonTexts(w):match("VOLTAR AO CURSO$"), buttonTexts(w))
	end)
end)

check("review: flashcard front/back layout and the four ratings map to SRS grades", function()
	withReviewWidget(600, 800, function(ReviewWidget, saves, shown)
		local course = metaCourse()
		local state = { progress = {}, answers = {}, reviews = {} }
		local w = ReviewWidget:new{ course = course, state = state }
		local texts = allTexts(w[1])
		assert(texts:match("DIREITO TRIBUTÁRIO"), "materia on the front: " .. texts)
		assert(texts:match("%[CRITICAL%] %[LAPSING%]"), "badges on the front")
		assert(texts:match("Pergunta do card 111%?"), "front text")
		assert(not texts:match("Resposta do card 111"), "back hidden before reveal")
		assert(buttonTexts(w) == "MOSTRAR RESPOSTA", buttonTexts(w))
		quizButtons(w)[1].callback()
		texts = allTexts(w[1])
		assert(texts:match("Pergunta do card 111%?") and texts:match("Resposta do card 111%."), "question kept with the answer")
		local ratings = quizButtons(w)
		assert(#ratings == 4, "four ratings")
		assert(ratings[1].text == "Again" and ratings[2].text == "Hard" and ratings[3].text == "Good" and ratings[4].text == "Easy", buttonTexts(w))
		ratings[1].callback()
		assert(state.reviews["111-card"].lapses == 1 and state.reviews["111-card"].reps == 0, "Again → lapse")
		assert(#saves == 1, "state saved")
		quizButtons(w)[1].callback()
		quizButtons(w)[3].callback()
		assert(state.reviews["333-card"].reps == 1 and state.reviews["333-card"].interval == 1, "Good → first interval")
		assert(#shown == 1, "done message shown after the last card")
	end)
end)

check("present: course insights aggregate only existing data", function()
	local course = sampleCourse()
	local stats = { modules = 2, lessons = 3, done = 1, quizzes = 3, answered = 2, due = 2 }
	local insights = Present.courseInsights(course, stats)
	assert(insights.progress == "1/3 aulas (33%)", insights.progress)
	assert(insights.quizzes == "2/3 quizzes (66%)", insights.quizzes)
	assert(insights.reviews == "2 due · 1 lapsing", insights.reviews)
	assert(insights.priorities[1].band == "CRITICAL" and insights.priorities[1].count == 1, "critical count")
	assert(insights.priorities[2].band == "HIGH" and insights.priorities[2].count == 1, "high count")
	assert(#insights.priorities == 2, "bands with zero are omitted")
	assert(insights.signals[1].signal == "LAPSING" and insights.signals[1].count == 1, "lapsing count")
	assert(insights.signals[2].signal == "UNSEEN" and insights.signals[2].count == 2, "lessons without feedback count as UNSEEN")
	assert(insights.materias[1].title == "Direito Tributário" and insights.materias[1].count == 2, "materia ranking")
	assert(insights.materias[2].title == "Contabilidade Geral" and insights.materias[2].count == 1, "materia ranking 2")
	assert(insights.hasFeedback == true, "feedback present")

	local bare = Present.courseInsights({ manifest = { modules = {} } }, { modules = 0, lessons = 0, done = 0, quizzes = 0, answered = 0, due = 0 })
	assert(bare.progress == "0/0 aulas (0%)" and #bare.priorities == 0 and bare.hasFeedback == false, "empty course insights")

	local items = Present.summaryItems(insights)
	local texts = {}
	for _, item in ipairs(items) do
		texts[#texts + 1] = item.text
		assert(item.select_enabled == false, "summary rows are read-only")
	end
	local joined = table.concat(texts, "\n")
	assert(joined:match("Progresso") and joined:match("1/3 aulas"), "progress row")
	assert(joined:match("Prioridades") and joined:match("CRITICAL 1") and joined:match("HIGH 1"), "priority row")
	assert(joined:match("StudyReader") and joined:match("LAPSING 1") and joined:match("UNSEEN 2"), "signal row")
	assert(joined:match("Matérias") and joined:match("Direito Tributário 2"), "materia row")
	local empty_items = Present.summaryItems(bare)
	local empty_joined = {}
	for _, item in ipairs(empty_items) do empty_joined[#empty_joined + 1] = item.text end
	empty_joined = table.concat(empty_joined, "\n")
	assert(empty_joined:match("sem metadata de prioridade") and empty_joined:match("sem feedback do StudyReader"), "empty insight rows")
end)

check("present: review entry and empty states never look broken", function()
	local due = Present.reviewEntry({ due = 30, lapsing = 2, unseen = 20, learning = 5 })
	assert(due.text:match("^▲ REVISAR AGORA  —  30 due · 2 lapsing"), due.text)
	assert(due.mandatory == "30 due" and due.bold == true, "due entry emphasised")
	local none = Present.reviewEntry({ due = 0, lapsing = 0, unseen = 0, learning = 0 })
	assert(none.text:match("^○ Revisar  —  ✓ nenhuma revisão pendente"), none.text)
	assert(none.bold == false and none.mandatory == "0 due", "no due → quiet entry")

	assert(Present.emptyItem("no-lessons").text == "Este curso ainda não possui aulas.", "course without lessons")
	assert(Present.emptyItem("no-module-lessons").text == "Este módulo ainda não possui aulas.", "module without lessons")
	assert(Present.emptyItem("no-lessons").select_enabled == false and Present.emptyItem("no-lessons").dim == true, "empty rows are inert and dimmed")
	assert(Present.EMPTY.no_reviews == "✓ Nenhuma revisão pendente", "no reviews text")
	assert(Present.EMPTY.no_quiz == "✓ Nenhum quiz pendente nesta aula", "no quiz text")
	assert(Present.EMPTY.no_courses:match("Nenhum curso"), "no courses text")
end)

check("present: progress and labels follow one convention", function()
	assert(Present.progressText(2, 30) == "2/30 aulas (6%)", Present.progressText(2, 30))
	assert(Present.progressText(1, 1, "quiz", "quizzes") == "1/1 quiz (100%)", "singular unit")
	assert(Present.coursesSubtitle(3, 31) == "3 cursos · 31 reviews", Present.coursesSubtitle(3, 31))
	assert(Present.coursesSubtitle(1, 0) == "1 curso", "no due → no review part")
	local course = sampleCourse()
	local lesson = Present.lessonItem(course.manifest.modules[1].lessons[1], false, { total = 1, answered = 0 },
		Present.lessonMeta(course, course.manifest.modules[1].lessons[1]))
	assert(lesson.text == "○ [CRITICAL] [LAPSING] Competência · Q111 · 3 erros · há 2 dias", lesson.text)
end)

check("quiz: small viewport keeps options wrapped and reachable", function()
	withQuizWidget(480, 640, function(QuizWidget)
		local w = newQuiz(QuizWidget, LONG_QUESTION)
		local view = w.cropping_widget
		assert(view.dimen.w == 480 - 30 and view.dimen.h == 640 - 80 - 30, "viewport follows the screen size")
		local buttons = quizButtons(w)
		assert(#buttons == 5 and buttons[5].label.width < view.dimen.w, "options fit beside the scrollbar")
		assert(buttons[1].label.face.size == 22, "font not reduced on small screens")
		assert(w[1]:getSize().h <= 640, "widget within the screen")
	end)
end)

if failures > 0 then
	print(string.format("\n%d failure(s)", failures))
	os.exit(1)
end
print("\nall plugin tests passed")
