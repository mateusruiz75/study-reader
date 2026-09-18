--[[-- Presentation helpers: menu item texts, badges and the lesson review panel.

Pure Lua (no KOReader dependencies) so the visual layer stays testable.
Everything shown here is derived from data the .study package and the
student state already contain — nothing is inferred or invented.
]]

local Present = {}

local BAR_FULL, BAR_EMPTY = "█", "░"
local MARK_DONE, MARK_TODO = "✓", "○"

local PRIORITIES = { CRITICAL = true, HIGH = true, MEDIUM = true, LOW = true }
local SIGNALS = { LAPSING = true, DUE = true, UNSEEN = true, LEARNING = true, STABLE = true }
local PRIORITY_ORDER = { "CRITICAL", "HIGH", "MEDIUM", "LOW" }

Present.PRIORITY_ORDER = PRIORITY_ORDER

local function percent(done, total)
    if not total or total <= 0 then return 0 end
    return math.floor(done * 100 / total)
end

function Present.percentText(done, total)
    return string.format("%d%%", percent(done, total))
end

function Present.progressText(done, total, singular, plural_form)
    singular = singular or "aula"
    plural_form = plural_form or "aulas"
    return string.format("%d/%d %s (%d%%)", done, total, total == 1 and singular or plural_form, percent(done, total))
end

function Present.coursesSubtitle(courses, due)
    local text = string.format("%d %s", courses, courses == 1 and "curso" or "cursos")
    if (due or 0) > 0 then text = text .. string.format(" · %d reviews", due) end
    return text
end

function Present.bar(done, total, width)
    width = width or 10
    local filled = 0
    if total and total > 0 then
        filled = math.floor(math.min(done, total) * width / total + 0.5)
    end
    return string.rep(BAR_FULL, filled) .. string.rep(BAR_EMPTY, width - filled)
end

local function plural(n, singular, plural_form)
    return string.format("%d %s", n, n == 1 and singular or plural_form)
end

function Present.priorityBadge(priority)
    if type(priority) == "string" and PRIORITIES[priority] then
        return "[" .. priority .. "]"
    end
    return nil
end

function Present.signalBadge(signal)
    if type(signal) == "string" and SIGNALS[signal] then
        return "[" .. signal .. "]"
    end
    return nil
end

function Present.lessonKey(lesson)
    local id = lesson and lesson.id or ""
    return id:match("^error%-(.+)$") or id
end

function Present.lessonMeta(course, lesson)
    local manifest = course and course.manifest
    local indio = manifest and manifest.extensions and manifest.extensions.indio
    local priorities = indio and indio.priorities
    if type(priorities) ~= "table" then return nil end
    local key = Present.lessonKey(lesson)
    local entry = priorities[key]
    if type(entry) ~= "table" then return nil end
    return {
        key = key,
        priority = PRIORITIES[entry.priority] and entry.priority or nil,
        rule = entry.rule,
        reasons = type(entry.priorityReasons) == "table" and entry.priorityReasons or {},
        errorCount = entry.errorCount,
        daysSinceLastError = entry.daysSinceLastError,
        signal = type(entry.study) == "table" and SIGNALS[entry.study.signal] and entry.study.signal or nil,
        reviewLapses = type(entry.study) == "table" and entry.study.reviewLapses or nil,
    }
end

function Present.priorityCounts(course, module)
    local counts = {}
    for _, lesson in ipairs(module.lessons or {}) do
        local meta = Present.lessonMeta(course, lesson)
        if meta and meta.priority then
            counts[meta.priority] = (counts[meta.priority] or 0) + 1
        end
    end
    return counts
end

local function priorityCountsText(counts)
    local parts = {}
    for _, band in ipairs(PRIORITY_ORDER) do
        if counts and counts[band] and counts[band] > 0 then
            parts[#parts + 1] = string.format("%d %s", counts[band], band)
        end
    end
    return table.concat(parts, " · ")
end

function Present.courseItem(title, stats)
    local pct = percent(stats.done, stats.lessons)
    local status
    if stats.lessons > 0 and stats.done >= stats.lessons then
        status = "concluído"
    elseif stats.done > 0 or (stats.answered or 0) > 0 then
        status = "em andamento"
    else
        status = "não iniciado"
    end
    local parts = { string.format("%d/%d aulas", stats.done, stats.lessons) }
    if (stats.due or 0) > 0 then
        parts[#parts + 1] = string.format("%d reviews", stats.due)
    end
    parts[#parts + 1] = status
    return {
        text = title .. "  —  " .. table.concat(parts, " · "),
        mandatory = string.format("%d%%", pct),
        mandatory_dim = pct >= 100,
        bold = stats.active == true,
    }
end

function Present.courseSubtitle(stats)
    local parts = {
        plural(stats.modules or 0, "módulo", "módulos"),
        string.format("%d/%d aulas", stats.done, stats.lessons),
    }
    if stats.quizzes and stats.quizzes > 0 then
        parts[#parts + 1] = string.format("%d/%d quizzes", stats.answered or 0, stats.quizzes)
    end
    if (stats.due or 0) > 0 then
        parts[#parts + 1] = string.format("%d reviews", stats.due)
    end
    return table.concat(parts, " · ")
end

function Present.moduleItem(title, stats, priority_counts)
    local parts = { string.format("%d/%d aulas", stats.done, stats.lessons) }
    local counts = priorityCountsText(priority_counts)
    if counts ~= "" then parts[#parts + 1] = counts end
    return {
        text = title .. "  —  " .. table.concat(parts, " · "),
        mandatory = Present.percentText(stats.done, stats.lessons),
        mandatory_dim = stats.lessons > 0 and stats.done >= stats.lessons,
    }
end

Present.EMPTY = {
    no_courses = "Nenhum curso .study encontrado. Copie os cursos para a pasta 'study' dos seus documentos.",
    no_lessons = "Este curso ainda não possui aulas.",
    no_module_lessons = "Este módulo ainda não possui aulas.",
    no_reviews = "✓ Nenhuma revisão pendente",
    no_reviews_detail = "Nenhum flashcard vencido agora. Volte mais tarde.",
    no_quiz = "✓ Nenhum quiz pendente nesta aula",
    no_priority = "sem metadata de prioridade neste curso",
    no_feedback = "sem feedback do StudyReader ainda",
}

local EMPTY_ITEMS = {
    ["no-lessons"] = Present.EMPTY.no_lessons,
    ["no-module-lessons"] = Present.EMPTY.no_module_lessons,
}

function Present.emptyItem(kind)
    return { text = EMPTY_ITEMS[kind] or Present.EMPTY.no_lessons, select_enabled = false, dim = true }
end

function Present.reviewEntry(counts)
    local due = counts.due or 0
    if due > 0 then
        local parts = { string.format("%d due", due) }
        if (counts.lapsing or 0) > 0 then parts[#parts + 1] = string.format("%d lapsing", counts.lapsing) end
        if (counts.learning or 0) > 0 then parts[#parts + 1] = string.format("%d learning", counts.learning) end
        if (counts.unseen or 0) > 0 then parts[#parts + 1] = string.format("%d unseen", counts.unseen) end
        return {
            text = "▲ REVISAR AGORA  —  " .. table.concat(parts, " · "),
            mandatory = string.format("%d due", due),
            bold = true,
        }
    end
    return {
        text = "○ Revisar  —  ✓ nenhuma revisão pendente",
        mandatory = "0 due",
        bold = false,
        mandatory_dim = true,
    }
end

function Present.signalCounts(course)
    local counts = {}
    for _, module in ipairs(course.manifest and course.manifest.modules or {}) do
        for _, lesson in ipairs(module.lessons or {}) do
            local meta = Present.lessonMeta(course, lesson)
            local signal = meta and meta.signal or "UNSEEN"
            counts[signal] = (counts[signal] or 0) + 1
        end
    end
    return counts
end

local SIGNAL_ORDER = { "LAPSING", "DUE", "UNSEEN", "LEARNING", "STABLE" }
Present.SIGNAL_ORDER = SIGNAL_ORDER

function Present.courseInsights(course, stats)
    local modules = course.manifest and course.manifest.modules or {}
    local priorities = {}
    for _, module in ipairs(modules) do
        for band, n in pairs(Present.priorityCounts(course, module)) do
            priorities[band] = (priorities[band] or 0) + n
        end
    end
    local ordered_priorities = {}
    for _, band in ipairs(PRIORITY_ORDER) do
        if (priorities[band] or 0) > 0 then
            ordered_priorities[#ordered_priorities + 1] = { band = band, count = priorities[band] }
        end
    end
    local signals = Present.signalCounts(course)
    local ordered_signals = {}
    local has_feedback = false
    for _, signal in ipairs(SIGNAL_ORDER) do
        if (signals[signal] or 0) > 0 then
            ordered_signals[#ordered_signals + 1] = { signal = signal, count = signals[signal] }
            if signal ~= "UNSEEN" then has_feedback = true end
        end
    end
    local materias = {}
    for _, module in ipairs(modules) do
        materias[#materias + 1] = { title = module.title, count = #(module.lessons or {}) }
    end
    table.sort(materias, function(a, b)
        if a.count ~= b.count then return a.count > b.count end
        return a.title < b.title
    end)
    local reviews = string.format("%d due", stats.due or 0)
    if (signals.LAPSING or 0) > 0 then reviews = reviews .. string.format(" · %d lapsing", signals.LAPSING) end
    return {
        progress = Present.progressText(stats.done, stats.lessons),
        quizzes = Present.progressText(stats.answered or 0, stats.quizzes or 0, "quiz", "quizzes"),
        reviews = reviews,
        priorities = ordered_priorities,
        signals = ordered_signals,
        materias = materias,
        hasFeedback = has_feedback,
        lapsing = signals.LAPSING or 0,
        unseen = signals.UNSEEN or 0,
        learning = signals.LEARNING or 0,
    }
end

local function countsLine(entries, key)
    local parts = {}
    for _, entry in ipairs(entries) do
        parts[#parts + 1] = string.format("%s %d", entry[key], entry.count)
    end
    return table.concat(parts, " · ")
end

function Present.summaryItems(insights)
    local function row(label, detail, mandatory)
        return { text = label .. "  —  " .. detail, mandatory = mandatory, select_enabled = false }
    end
    local items = {
        row("Progresso", insights.progress),
        row("Quizzes", insights.quizzes),
        row("Reviews", insights.reviews),
        row("Prioridades", #insights.priorities > 0 and countsLine(insights.priorities, "band") or Present.EMPTY.no_priority),
        row("StudyReader", insights.hasFeedback and countsLine(insights.signals, "signal") or Present.EMPTY.no_feedback),
    }
    if #insights.materias > 0 then
        local top = {}
        for i = 1, math.min(5, #insights.materias) do top[i] = insights.materias[i] end
        items[#items + 1] = row("Matérias", countsLine(top, "title"))
    end
    return items
end

function Present.lessonItem(lesson, completed, quiz, meta)
    local lead = { completed and MARK_DONE or MARK_TODO }
    if meta then
        local badge = Present.priorityBadge(meta.priority)
        if badge then lead[#lead + 1] = badge end
        local signal = meta.signal ~= "UNSEEN" and Present.signalBadge(meta.signal) or nil
        if signal then lead[#lead + 1] = signal end
    end
    local text = table.concat(lead, " ") .. " " .. lesson.title
    if meta and meta.errorCount then
        text = text .. " · " .. plural(meta.errorCount, "erro", "erros")
    end
    if meta and meta.daysSinceLastError then
        text = text .. string.format(" · há %s", plural(meta.daysSinceLastError, "dia", "dias"))
    end
    local mandatory
    local answered = quiz and quiz.answered or 0
    if quiz and quiz.total and quiz.total > 0 then
        local status = ""
        if answered > 0 and quiz.correct == true then status = "✓ "
        elseif answered > 0 and quiz.correct == false then status = "✗ " end
        mandatory = string.format("%s%d/%d", status, answered, quiz.total)
    end
    return {
        text = text,
        mandatory = mandatory,
        mandatory_dim = answered == 0,
    }
end

local UPPER_ACCENTS = {
    ["á"] = "Á", ["à"] = "À", ["â"] = "Â", ["ã"] = "Ã", ["é"] = "É", ["ê"] = "Ê", ["í"] = "Í",
    ["ó"] = "Ó", ["ô"] = "Ô", ["õ"] = "Õ", ["ú"] = "Ú", ["ü"] = "Ü", ["ç"] = "Ç",
}

local function upper(text)
    local result = tostring(text or ""):upper()
    for lower_char, upper_char in pairs(UPPER_ACCENTS) do
        result = result:gsub(lower_char, upper_char)
    end
    return result
end

Present.upper = upper

local function badgesLine(meta)
    if not meta then return nil end
    local parts = {}
    local priority = Present.priorityBadge(meta.priority)
    if priority then parts[#parts + 1] = priority end
    local signal = Present.signalBadge(meta.signal)
    if signal then parts[#parts + 1] = signal end
    return #parts > 0 and table.concat(parts, " ") or nil
end

Present.badgesLine = badgesLine

function Present.moduleTitleForKey(course, key)
    local manifest = course and course.manifest
    for _, module in ipairs(manifest and manifest.modules or {}) do
        for _, lesson in ipairs(module.lessons or {}) do
            if Present.lessonKey(lesson) == key then return module.title, lesson end
        end
    end
    return nil, nil
end

function Present.quizHeader(course, lesson, question_id, index, total)
    local key = question_id and question_id:match("^(.+)%-recovery$") or nil
    local materia = key and Present.moduleTitleForKey(course, key) or nil
    local meta = key and Present.lessonMeta(course, { id = "error-" .. key }) or nil
    local kicker
    if materia then
        kicker = upper(materia) .. (key and (" · Q" .. key) or "")
    else
        kicker = upper(lesson and lesson.title or "Quiz")
    end
    return {
        kicker = kicker,
        badges = badgesLine(meta),
        counter = string.format("Questão %d / %d", index, total),
    }
end

function Present.optionLabel(option, selected)
    return string.format("%s %s) %s", selected and "☑" or "☐", option.id, option.text)
end

local function describeOptions(question, ids)
    local parts = {}
    for _, id in ipairs(ids) do
        local text = id
        for _, option in ipairs(question.options or {}) do
            if option.id == id then
                text = string.format("%s) %s", option.id, option.text)
                break
            end
        end
        parts[#parts + 1] = text
    end
    return table.concat(parts, "\n")
end

function Present.feedbackTexts(question, selected_ids, correct)
    local texts = {
        headline = correct and "✓ CORRETO" or "✗ INCORRETO",
        explanation = question.explanation,
    }
    if not correct then
        texts.marked = describeOptions(question, selected_ids or {})
        texts.correct = describeOptions(question, question.correct or {})
    end
    return texts
end

function Present.summaryTexts(correct, total, lesson_done)
    local pct = percent(correct, total)
    return {
        title = lesson_done and "REVISÃO CONCLUÍDA" or "QUIZ CONCLUÍDO",
        score = string.format("%d / %d", correct, total),
        percent = string.format("%d%%", pct),
        status = lesson_done and "✓ Aula concluída" or nil,
    }
end

function Present.cardMeta(course, card)
    local key = card and card.id and card.id:match("^(.+)%-card$") or nil
    local materia = key and Present.moduleTitleForKey(course, key) or nil
    local meta = key and Present.lessonMeta(course, { id = "error-" .. key }) or nil
    return { key = key, materia = materia, badges = badgesLine(meta) }
end

function Present.ratingLabels()
    return { "Again", "Hard", "Good", "Easy" }
end

local function escape(text)
    return (tostring(text):gsub("&", "&amp;"):gsub("<", "&lt;"):gsub(">", "&gt;"):gsub('"', "&quot;"))
end

function Present.panelCss()
    return table.concat({
        ".sr-panel { border: 1px solid #444; padding: 0.55em 0.7em; margin: 0.2em 0 0.9em 0; background-color: #f6f6f6; line-height: 1.45 }",
        ".sr-kicker { font-size: 0.8em; letter-spacing: 0.08em; color: #555; text-transform: uppercase; margin: 0 }",
        ".sr-title { font-size: 1.25em; font-weight: bold; margin: 0.1em 0 0.4em 0 }",
        ".sr-badges { margin: 0.2em 0 0.5em 0 }",
        ".sr-badge { display: inline; font-size: 0.75em; font-weight: bold; letter-spacing: 0.06em; padding: 0.12em 0.5em; border: 1px solid #333; margin-right: 0.4em; white-space: nowrap }",
        ".sr-p-critical { background-color: #222; color: #fff }",
        ".sr-p-high { background-color: #666; color: #fff }",
        ".sr-p-medium { background-color: #ddd; color: #000 }",
        ".sr-p-low { background-color: #fff; color: #333 }",
        ".sr-s-lapsing { background-color: #444; color: #fff; border-style: dashed }",
        ".sr-s-due { background-color: #888; color: #fff; border-style: dashed }",
        ".sr-s-unseen, .sr-s-learning, .sr-s-stable { background-color: #fff; color: #333; border-style: dashed }",
        ".sr-statement { margin: 0.3em 0 0.5em 0; font-size: 1.05em }",
        ".sr-kv { margin: 0.15em 0 }",
        ".sr-k { font-size: 0.8em; color: #555; text-transform: uppercase; letter-spacing: 0.04em }",
        ".sr-wrong { color: #000; text-decoration: line-through }",
        ".sr-right { font-weight: bold }",
        ".sr-reasons { margin: 0.3em 0 0 1.1em; font-size: 0.9em; color: #333 }",
        "h3 { border-bottom: 1px solid #bbb; padding-bottom: 0.15em; margin-top: 1em }",
    }, "\n")
end

local function badgeHtml(class, label)
    return string.format('<span class="sr-badge %s">%s</span>', class, escape(label))
end

function Present.lessonPanel(info)
    local out = {}
    out[#out + 1] = '<div class="sr-panel">'
    out[#out + 1] = string.format('<p class="sr-kicker">%s%s</p>',
        escape(info.materia or ""),
        info.question_id and (" · Q" .. escape(info.question_id)) or "")
    if info.assunto and info.assunto ~= "" then
        out[#out + 1] = string.format('<p class="sr-title">%s</p>', escape(info.assunto))
    end
    local meta = info.meta
    local badges = {}
    if meta and meta.priority then
        badges[#badges + 1] = badgeHtml("sr-p-" .. meta.priority:lower(), meta.priority)
    end
    if meta and meta.signal then
        badges[#badges + 1] = badgeHtml("sr-s-" .. meta.signal:lower(), meta.signal)
    end
    if info.quiz and info.quiz.answered then
        badges[#badges + 1] = badgeHtml(info.quiz.correct and "sr-p-low" or "sr-s-lapsing",
            info.quiz.correct and "quiz certo" or "quiz errado")
    end
    if #badges > 0 then
        out[#out + 1] = '<p class="sr-badges">' .. table.concat(badges, " ") .. "</p>"
    end
    if info.statement then
        out[#out + 1] = string.format('<p class="sr-kv"><span class="sr-k">Questão</span></p><p class="sr-statement">%s</p>',
            escape(info.statement))
    end
    if info.marked then
        out[#out + 1] = string.format('<p class="sr-kv"><span class="sr-k">Resposta marcada</span><br/><span class="sr-wrong">%s</span></p>',
            escape(info.marked))
    end
    if info.correct then
        out[#out + 1] = string.format('<p class="sr-kv"><span class="sr-k">Resposta correta</span><br/><span class="sr-right">%s</span></p>',
            escape(info.correct))
    end
    if meta and meta.reasons and #meta.reasons > 0 then
        local items = {}
        for _, reason in ipairs(meta.reasons) do
            items[#items + 1] = "<li>" .. escape(reason) .. "</li>"
        end
        out[#out + 1] = '<ul class="sr-reasons">' .. table.concat(items) .. "</ul>"
    end
    out[#out + 1] = "</div>"
    return table.concat(out, "\n")
end

return Present
