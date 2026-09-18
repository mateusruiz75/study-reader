--[[-- ReviewWidget: flashcard review with SM-2 grading (Again/Hard/Good/Easy).]]

local Blitbuffer = require("ffi/blitbuffer")
local Button = require("ui/widget/button")
local CenterContainer = require("ui/widget/container/centercontainer")
local Device = require("device")
local FocusManager = require("ui/widget/focusmanager")
local Font = require("ui/font")
local FrameContainer = require("ui/widget/container/framecontainer")
local Geom = require("ui/geometry")
local HorizontalGroup = require("ui/widget/horizontalgroup")
local HorizontalSpan = require("ui/widget/horizontalspan")
local InfoMessage = require("ui/widget/infomessage")
local LineWidget = require("ui/widget/linewidget")
local Size = require("ui/size")
local TextBoxWidget = require("ui/widget/textboxwidget")
local TextWidget = require("ui/widget/textwidget")
local TitleBar = require("ui/widget/titlebar")
local UIManager = require("ui/uimanager")
local VerticalGroup = require("ui/widget/verticalgroup")
local VerticalSpan = require("ui/widget/verticalspan")
local _ = require("gettext")

local Present = require("present")
local SRS = require("srs")
local State = require("state")

local ReviewWidget = FocusManager:extend{
    course = nil,
    state = nil,
    onExit = nil,
}

local PADDING = Size.padding.large

function ReviewWidget:init()
    self.due = {}
    for _, card in ipairs(self.course.flashcards) do
        local schedule = self.state.reviews[card.id] or SRS.newCard()
        if SRS.isDue(schedule) then
            self.due[#self.due + 1] = card
        end
    end
    self.index = 1
    self.revealed = false
    self.dimen = Geom:new{
        w = Device.screen:getWidth(),
        h = Device.screen:getHeight(),
    }
    if Device:hasKeys() then
        self.key_events.Close = { { Device.input.group.Back } }
    end
    self:_populate()
end

function ReviewWidget:width()
    return self.dimen.w - 2 * PADDING
end

function ReviewWidget:_populate()
    self.layout = {}
    local group = VerticalGroup:new{ align = "left" }
    local width = self:width()

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
    local function addButtonRow(labels, on_press)
        local gap = Size.padding.default
        local button_w = math.floor((width - gap * (#labels - 1)) / #labels)
        local row = HorizontalGroup:new{ align = "center" }
        local focus_row = {}
        for i, label in ipairs(labels) do
            local button = Button:new{
                text = label,
                width = button_w,
                callback = function() on_press(i) end,
                show_parent = self,
            }
            focus_row[#focus_row + 1] = button
            row[#row + 1] = button
            if i < #labels then row[#row + 1] = HorizontalSpan:new{ width = gap } end
        end
        self.layout[#self.layout + 1] = focus_row
        group[#group + 1] = row
    end

    if #self.due == 0 then
        addText(Present.EMPTY.no_reviews, Font:getFace("NotoSans-Bold.ttf", 26), true)
        addSpan(PADDING)
        addWrapped(Present.EMPTY.no_reviews_detail, Font:getFace("cfont", 22))
        addSpan(PADDING)
        addButton(_("VOLTAR"), function() self:onClose() end)
    else
        local card = self.due[self.index]
        local info = Present.cardMeta(self.course, card)
        if info.materia then
            addLabel(Present.upper(info.materia) .. (info.key and (" · Q" .. info.key) or ""))
        end
        if info.badges then
            addSpan(Size.padding.small)
            addText(info.badges, Font:getFace("smallinfofont"), true)
        end
        addSpan(Size.padding.small)
        addLabel(string.format(_("Flashcard %d / %d"), self.index, #self.due))
        addDivider()
        if self.revealed then
            addLabel(_("PERGUNTA"))
            addWrapped(card.front, Font:getFace("cfont", 22))
            addDivider()
            addLabel(_("RESPOSTA"))
            addWrapped(card.back, Font:getFace("cfont", 26))
            addSpan(PADDING)
            addLabel(_("COMO FOI?"))
            addSpan(Size.padding.small)
            addButtonRow(Present.ratingLabels(), function(grade_index) self:onGrade(grade_index) end)
        else
            addLabel(_("PERGUNTA"))
            addWrapped(card.front, Font:getFace("cfont", 26))
            addSpan(PADDING)
            addButton(_("MOSTRAR RESPOSTA"), function()
                self.revealed = true
                self:_populate()
            end)
        end
    end

    local title_bar = TitleBar:new{
        title = _("Reviews"),
        width = self.dimen.w - 2 * PADDING,
        align = "center",
        close_callback = function() self:onClose() end,
        show_parent = self,
    }
    local filler = math.max(0,
        self.dimen.h - group:getSize().h - title_bar:getHeight() - 3 * PADDING)
    local top_filler = math.floor(filler / 2)
    local full_group = VerticalGroup:new{ align = "left" }
    full_group[1] = title_bar
    full_group[2] = VerticalSpan:new{ width = top_filler }
    for i = 1, #group do
        full_group[#full_group + 1] = group[i]
    end
    full_group[#full_group + 1] = VerticalSpan:new{ width = filler - top_filler }

    self[1] = FrameContainer:new{
        background = Blitbuffer.COLOR_WHITE,
        bordersize = 0,
        margin = 0,
        padding = PADDING,
        full_group,
    }
    self:refocusWidget()
    UIManager:setDirty(self, "ui")
end

function ReviewWidget:onGrade(grade_index)
    local card = self.due[self.index]
    local schedule = self.state.reviews[card.id] or SRS.newCard()
    self.state.reviews[card.id] = SRS.grade(schedule, grade_index)
    State.save(self.course.id, self.state)
    if self.index < #self.due then
        self.index = self.index + 1
        self.revealed = false
        self:_populate()
    else
        UIManager:close(self)
        UIManager:show(InfoMessage:new{
            text = _("Reviews done for now. See you soon!"),
            timeout = 4,
        })
        if self.onExit then self.onExit() end
    end
end

function ReviewWidget:onClose()
    UIManager:close(self)
    if self.onExit then self.onExit() end
end

return ReviewWidget
