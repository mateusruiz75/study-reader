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
local ScrollableContainer = require("ui/widget/container/scrollablecontainer")
local Size = require("ui/size")
local TextBoxWidget = require("ui/widget/textboxwidget")
local TextWidget = require("ui/widget/textwidget")
local TitleBar = require("ui/widget/titlebar")
local UIManager = require("ui/uimanager")
local VerticalGroup = require("ui/widget/verticalgroup")
local VerticalSpan = require("ui/widget/verticalspan")
local _ = require("gettext")

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
            VerticalSpan:new{ width = math.floor((body_h - body:getSize().h) / 2) },
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
    local function addButton(text, callback)
        local button = Button:new{
            text = text,
            width = width,
            callback = callback,
            show_parent = self,
        }
        self.layout[#self.layout + 1] = { button }
        group[#group + 1] = CenterContainer:new{
            dimen = Geom:new{ w = width, h = button:getSize().h },
            button,
        }
        return button
    end

    if self.mode == "summary" then
        self:_populateSummary(group, addText, addWrapped, addSpan, addButton)
    elseif #self.pending == 0 then
        addText(_("Quiz done!"), Font:getFace("NotoSans-Bold.ttf", 26), true)
        addSpan(PADDING)
        addButton(_("Close"), function() self:onClose() end)
    elseif self.mode == "feedback" then
        self:_populateFeedback(group, addText, addWrapped, addSpan, addButton)
    else
        self:_populateQuestion(group, addText, addWrapped, addSpan, addButton)
    end
    return group
end

function QuizWidget:_populateQuestion(group, addText, addWrapped, addSpan, addButton)
    local id = self.pending[self.index]
    local question = self.course.questions[id]
    addText(string.format("%s · %s", self.lesson and self.lesson.title or "",
        string.format(_("Question %d / %d"), self.index, #self.pending)),
        Font:getFace("smallinfofont"))
    addSpan(PADDING)
    addWrapped(question.question, Font:getFace("cfont", 24))
    if question.code then
        addSpan(Size.padding.default)
        addWrapped(question.code, Font:getFace("infont", 18))
    end
    addSpan(PADDING)
    for _, option in ipairs(question.options) do
        local prefix = self.selected[option.id] and "☑ " or "☐ "
        addButton(string.format("%s%s) %s", prefix, option.id, option.text), function()
            self:onOption(option.id)
        end)
        addSpan(Size.padding.small)
    end
    if question.type == "multiple-choice" then
        addSpan(Size.padding.default)
        addButton(_("Confirm"), function() self:onConfirm() end)
    end
end

function QuizWidget:_populateFeedback(group, addText, addWrapped, addSpan, addButton)
    local id = self.pending[self.index]
    local question = self.course.questions[id]
    local correct_ids = {}
    for _, oid in ipairs(question.correct) do
        correct_ids[#correct_ids + 1] = oid .. ")"
    end
    if self.last_correct then
        addText("✓ " .. _("Correct!"), Font:getFace("NotoSans-Bold.ttf", 26), true)
    else
        addText("✗ " .. _("Incorrect"), Font:getFace("NotoSans-Bold.ttf", 26), true)
        addSpan(Size.padding.small)
        addText(_("Correct answer:") .. " " .. table.concat(correct_ids, " "),
            Font:getFace("cfont", 22))
    end
    if question.explanation then
        addSpan(PADDING)
        addWrapped(question.explanation, Font:getFace("cfont", 22))
    end
    addSpan(PADDING)
    if self.index < #self.pending then
        addButton(_("Next question"), function() self:onNext() end)
    else
        addButton(_("See results"), function() self:onFinish() end)
    end
end

function QuizWidget:_populateSummary(group, addText, addWrapped, addSpan, addButton)
    local pct = self.session_total > 0
        and math.floor(self.session_correct * 100 / self.session_total) or 0
    addText(_("Lesson complete!"), Font:getFace("NotoSans-Bold.ttf", 30), true)
    addSpan(PADDING)
    addWrapped(string.format(_("Score: %d / %d (%d%%)"),
        self.session_correct, self.session_total, pct),
        Font:getFace("cfont", 26))
    addSpan(PADDING)
    if self.next_lesson then
        addButton(string.format(_("Next lesson: %s"), self.next_lesson.title),
            function()
                UIManager:close(self)
                if self.onNext then self.onNext() end
            end)
        addSpan(Size.padding.default)
    end
    addButton(_("Back to course"), function() self:onClose() end)
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
