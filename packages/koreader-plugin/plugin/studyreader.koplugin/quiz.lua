--[[-- QuizWidget: runs a lesson's quiz inline (single/multiple choice).

v2: practice mode re-asks every question on completed lessons; the summary
screen shows the score and chains straight into the next lesson.
]]

local Blitbuffer = require("ffi/blitbuffer")
local Button = require("ui/widget/button")
local CenterContainer = require("ui/widget/container/centercontainer")
local Device = require("device")
local FocusManager = require("ui/widget/focusmanager")
local Font = require("ui/font")
local FrameContainer = require("ui/widget/container/framecontainer")
local Geom = require("ui/geometry")
local GestureRange = require("ui/gesturerange")
local InputContainer = require("ui/widget/container/inputcontainer")
local LineWidget = require("ui/widget/linewidget")
local ScrollableContainer = require("ui/widget/container/scrollablecontainer")
local Size = require("ui/size")
local TextBoxWidget = require("ui/widget/textboxwidget")
local TextWidget = require("ui/widget/textwidget")
local TitleBar = require("ui/widget/titlebar")
local UIManager = require("ui/uimanager")
local VerticalGroup = require("ui/widget/verticalgroup")
local VerticalSpan = require("ui/widget/verticalspan")
local _ = require("gettext")

local Present = require("present")
local State = require("state")

local QuizWidget = FocusManager:extend{
    course = nil,
    lesson = nil,
    question_ids = nil,
    state = nil,
    practice = false,
    next_lesson = nil,
    onNext = nil,
    onExit = nil,
}

local PADDING = Size.padding.large
local OPTION_FONT_SIZE = 22

-- A tappable, fully wrapped alternative: Button shrinks or truncates long
-- texts, so options get their own frame + TextBoxWidget. Selection and
-- keyboard focus both invert the frame (no colour needed).
local OptionButton = InputContainer:extend{
    text = nil,
    width = nil,
    selected = false,
    callback = nil,
    show_parent = nil,
}

function OptionButton:init()
    local inset = Size.border.button + Size.padding.button
    self.label = TextBoxWidget:new{
        text = self.text,
        face = Font:getFace("cfont", OPTION_FONT_SIZE),
        width = self.width - 2 * inset,
    }
    self.frame = FrameContainer:new{
        width = self.width,
        bordersize = Size.border.button,
        padding = Size.padding.button,
        background = Blitbuffer.COLOR_WHITE,
        invert = self.selected,
        self.label,
    }
    self[1] = self.frame
    local size = self.frame:getSize()
    self.dimen = Geom:new{ w = size.w, h = size.h }
    self.ges_events = {
        TapSelect = { GestureRange:new{ ges = "tap", range = function() return self.dimen end } },
    }
end

function OptionButton:getSize()
    return self.frame:getSize()
end

function OptionButton:onTapSelect()
    if self.callback then self.callback() end
    return true
end

function OptionButton:onFocus()
    self.frame.invert = true
    return true
end

function OptionButton:onUnfocus()
    self.frame.invert = self.selected
    return true
end

function QuizWidget:init()
    self.pending = {}
    for _, id in ipairs(self.question_ids) do
        if self.practice or not State.answeredQuestion(self.state, id) then
            self.pending[#self.pending + 1] = id
        end
    end
    self.session_total = #self.pending
    self.session_correct = 0
    self.index = 1
    self.selected = {}
    self.mode = nil
    self.dimen = Geom:new{
        w = Device.screen:getWidth(),
        h = Device.screen:getHeight(),
    }
    if Device:hasKeys() then
        self.key_events.Close = { { Device.input.group.Back } }
    end
    self:_populate()
end

function QuizWidget:width()
    return self.dimen.w - 2 * PADDING
end

-- Rebuilds the screen: a fixed TitleBar above a ScrollableContainer holding
-- the question/feedback/summary body, so long statements and options stay
-- reachable on any screen size. A new container starts scrolled to the top;
-- keep_scroll preserves the offset (multiple-choice option toggles).
function QuizWidget:_populate(keep_scroll)
    local title_bar = TitleBar:new{
        title = self.lesson and self.lesson.title or _("Quiz"),
        width = self:width(),
        align = "center",
        close_callback = function() self:onClose() end,
        show_parent = self,
    }
    local body_w = self:width()
    local body_h = math.max(0, self.dimen.h - 2 * PADDING - title_bar:getHeight())

    local body = self:_buildBody(body_w)
    if body:getSize().h > body_h then
        -- Overflow: rebuild narrower so the vertical scrollbar fits beside
        -- the content (a full-width body would also scroll horizontally).
        body = self:_buildBody(body_w - ScrollableContainer:getScrollbarWidth())
    else
        body = VerticalGroup:new{
            align = "left",
            VerticalSpan:new{ width = PADDING },
            body,
        }
    end

    local offset = keep_scroll and self.cropping_widget
        and self.cropping_widget:getScrolledOffset()
    if self.cropping_widget then
        self.cropping_widget:onCloseWidget() -- free its compose buffer
    end
    -- UIManager clips inner repaints/inverts to self.cropping_widget.
    self.cropping_widget = ScrollableContainer:new{
        dimen = Geom:new{ w = body_w, h = body_h },
        show_parent = self,
        body,
    }
    if offset then
        self.cropping_widget:setScrolledOffset(offset)
    end

    self[1] = FrameContainer:new{
        background = Blitbuffer.COLOR_WHITE,
        bordersize = 0,
        margin = 0,
        padding = PADDING,
        VerticalGroup:new{
            align = "left",
            title_bar,
            self.cropping_widget,
        },
    }
    self:refocusWidget()
    UIManager:setDirty(self, "ui")
end

function QuizWidget:_buildBody(width)
    self.layout = {}
    local group = VerticalGroup:new{ align = "left" }

    local function addText(text, face, bold)
        group[#group + 1] = TextWidget:new{
            text = text,
            face = face,
            bold = bold or false,
            max_width = width,
        }
    end
    local function addWrapped(text, face)
        group[#group + 1] = TextBoxWidget:new{
            text = text,
            face = face,
            width = width,
        }
    end
    local function addSpan(h)
        group[#group + 1] = VerticalSpan:new{ width = h }
    end
    local function addButton(text, callback, opts)
        opts = opts or {}
        local button = Button:new{
            text = text,
            width = width,
            callback = callback,
            show_parent = self,
            align = opts.align or "center",
            preselect = opts.preselect or false,
            text_font_bold = opts.bold ~= false,
        }
        self.layout[#self.layout + 1] = { button }
        group[#group + 1] = CenterContainer:new{
            dimen = Geom:new{ w = width, h = button:getSize().h },
            button,
        }
        return button
    end
    local function addLabel(text)
        addText(text, Font:getFace("smallinfofont"))
    end
    local function addDivider()
        addSpan(Size.padding.default)
        group[#group + 1] = LineWidget:new{
            dimen = Geom:new{ w = width, h = Size.line.medium },
            background = Blitbuffer.COLOR_DARK_GRAY,
        }
        addSpan(Size.padding.default)
    end
    local function addOption(text, selected, callback)
        local option = OptionButton:new{
            text = text,
            width = width,
            selected = selected,
            callback = callback,
            show_parent = self,
        }
        self.layout[#self.layout + 1] = { option }
        group[#group + 1] = option
        return option
    end
    local ui = {
        text = addText, wrapped = addWrapped, span = addSpan, button = addButton,
        option = addOption, label = addLabel, divider = addDivider, width = width,
    }

    if self.mode == "summary" then
        self:_populateSummary(ui)
    elseif #self.pending == 0 then
        addText(_("Quiz done!"), Font:getFace("NotoSans-Bold.ttf", 26), true)
        addSpan(PADDING)
        addButton(_("Close"), function() self:onClose() end)
    elseif self.mode == "feedback" then
        self:_populateFeedback(ui)
    else
        self:_populateQuestion(ui)
    end
    return group
end

function QuizWidget:_addHeader(ui, id)
    local header = Present.quizHeader(self.course, self.lesson, id, self.index, #self.pending)
    ui.label(header.kicker)
    if header.badges then
        ui.span(Size.padding.small)
        ui.text(header.badges, Font:getFace("smallinfofont"), true)
    end
    ui.span(Size.padding.small)
    ui.label(header.counter)
    ui.divider()
end

function QuizWidget:_populateQuestion(ui)
    local id = self.pending[self.index]
    local question = self.course.questions[id]
    self:_addHeader(ui, id)
    ui.wrapped(question.question, Font:getFace("cfont", 24))
    if question.code then
        ui.span(Size.padding.default)
        ui.wrapped(question.code, Font:getFace("infont", 18))
    end
    ui.span(PADDING)
    for _, option in ipairs(question.options) do
        local selected = self.selected[option.id] == true
        ui.option(Present.optionLabel(option, selected), selected, function()
            self:onOption(option.id)
        end)
        ui.span(Size.padding.large)
    end
    if question.type == "multiple-choice" then
        ui.span(Size.padding.default)
        ui.button(_("Confirmar"), function() self:onConfirm() end)
    end
end

function QuizWidget:_populateFeedback(ui)
    local id = self.pending[self.index]
    local question = self.course.questions[id]
    self:_addHeader(ui, id)
    local texts = Present.feedbackTexts(question, self.last_selected or {}, self.last_correct)
    ui.text(texts.headline, Font:getFace("NotoSans-Bold.ttf", 28), true)
    if texts.marked then
        ui.span(PADDING)
        ui.label(_("VOCÊ MARCOU"))
        ui.wrapped(texts.marked, Font:getFace("cfont", 22))
        ui.span(Size.padding.default)
        ui.label(_("RESPOSTA CORRETA"))
        ui.wrapped(texts.correct, Font:getFace("cfont", 22))
    end
    if texts.explanation then
        ui.divider()
        ui.label(_("EXPLICAÇÃO"))
        ui.wrapped(texts.explanation, Font:getFace("cfont", 22))
    end
    ui.span(PADDING)
    if self.index < #self.pending then
        ui.button(_("PRÓXIMA QUESTÃO"), function() self:onNext() end)
    else
        ui.button(_("VER RESULTADO"), function() self:onFinish() end)
    end
end

function QuizWidget:_populateSummary(ui)
    local lesson_done = self.lesson ~= nil and State.completedLesson(self.state, self.lesson.id)
    local texts = Present.summaryTexts(self.session_correct, self.session_total, lesson_done)
    ui.text(texts.title, Font:getFace("NotoSans-Bold.ttf", 30), true)
    ui.divider()
    ui.label(_("SCORE"))
    ui.text(texts.score, Font:getFace("NotoSans-Bold.ttf", 34), true)
    ui.text(texts.percent, Font:getFace("cfont", 26))
    if texts.status then
        ui.span(Size.padding.default)
        ui.text(texts.status, Font:getFace("cfont", 22), true)
    end
    ui.span(PADDING)
    if self.next_lesson then
        ui.button(string.format(_("PRÓXIMA AULA: %s"), self.next_lesson.title),
            function()
                UIManager:close(self)
                if self.onNext then self.onNext() end
            end)
        ui.span(Size.padding.default)
    end
    ui.button(_("VOLTAR AO CURSO"), function() self:onClose() end, { bold = false })
end

function QuizWidget:onOption(option_id)
    local id = self.pending[self.index]
    local question = self.course.questions[id]
    if question.type == "single-choice" then
        self.selected = { [option_id] = true }
        self:_grade()
    else
        if self.selected[option_id] then
            self.selected[option_id] = nil
        else
            self.selected[option_id] = true
        end
        self:_populate(true)
    end
end

function QuizWidget:onConfirm()
    if next(self.selected) then
        self:_grade()
    end
end

function QuizWidget:_grade()
    local id = self.pending[self.index]
    local question = self.course.questions[id]
    local selected = {}
    local correct = true
    for option_id in pairs(self.selected) do
        selected[#selected + 1] = option_id
    end
    table.sort(selected)
    table.sort(question.correct)
    if #selected ~= #question.correct then
        correct = false
    else
        for i, option_id in ipairs(selected) do
            if question.correct[i] ~= option_id then correct = false end
        end
    end
    if correct then self.session_correct = self.session_correct + 1 end
    State.recordAnswer(self.state, id, selected, correct)
    State.save(self.course.id, self.state)
    self.last_correct = correct
    self.last_selected = selected
    self.mode = "feedback"
    self:_populate()
end

function QuizWidget:onNext()
    self.index = self.index + 1
    self.selected = {}
    self.mode = nil
    self:_populate()
end

function QuizWidget:onFinish()
    local all_answered = true
    for _, id in ipairs(self.question_ids) do
        if not State.answeredQuestion(self.state, id) then
            all_answered = false
        end
    end
    if all_answered and self.lesson then
        State.markLessonDone(self.state, self.lesson.id)
        State.save(self.course.id, self.state)
    end
    self.mode = "summary"
    self:_populate()
end

function QuizWidget:onClose()
    UIManager:close(self)
    if self.onExit then self.onExit() end
end

return QuizWidget
