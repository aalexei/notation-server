-- Pandoc filter: point links at the notation server, and dress up Org.
--
--   notation:ID          -> /note/ID  (as a link the frontend intercepts)
--   relative paths and   -> /files/<note id>/<path>  (attachments, images)
--   attachment:PATH
--   TODO keywords        -> coloured pills (style="--kw: <colour>")
--   [#A] priorities      -> badges; heading tags gathered at the end
--   SCHEDULED/CLOSED/... -> a "planning" line
--   each heading         -> a <details> section that can be folded
--
-- The id of the note being rendered comes from the `notation_id' metadata
-- field, set on the command line with -M notation_id=... Sections start
-- folded when `notation_folded' is set (Org's #+STARTUP: overview), and
-- done subtrees always do.

local note_id = ""
local folded = false

-- Colours for common keywords; any other keyword gets a stable one from
-- the palette, so it looks the same in every note.
local KEYWORD_COLOURS = {
  TODO = "--series-2", NEXT = "--series-1", STARTED = "--series-3", WAITING = "--series-4",
  DONE = "--series-6", CANCELLED = "--other", CANCELED = "--other",
}

local function keyword_colour(keyword, done)
  if KEYWORD_COLOURS[keyword] then return KEYWORD_COLOURS[keyword] end
  if done then return "--other" end
  local hash = 0
  for i = 1, #keyword do hash = (hash * 31 + keyword:byte(i)) % 65536 end
  return "--series-" .. (hash % 8 + 1)
end

local PLANNING = { ["SCHEDULED:"] = true, ["DEADLINE:"] = true, ["CLOSED:"] = true }

local function is_relative(target)
  return not (target:match("^%a[%w+.-]*:") or target:match("^/") or target:match("^#"))
end

local function rewrite_target(target)
  local id = target:match("^notation:(%d%d%d%d%d%d%d%d%d%d%d%d%d%d)$")
  if id then
    return "/note/" .. id, id
  end
  target = target:gsub("^file:", "")
  -- Under notation, org-attach keeps a note's attachments next to it.
  target = target:gsub("^attachment:", "")
  if note_id ~= "" and is_relative(target) then
    return "/files/" .. note_id .. "/" .. target:gsub("^%./", ""), nil
  end
  return target, nil
end

local function note_link(id, content)
  return pandoc.Link(content, "/note/" .. id, "",
                     pandoc.Attr("", { "notation-link" }, { ["data-note-id"] = id }))
end

local filter = {
  Link = function(el)
    -- The Str rule below has already run on the link text (walks are
    -- bottom-up); unwrap any link it made so links never nest.
    el.content = el.content:walk({ Link = function(inner) return inner.content end })
    local target, id = rewrite_target(el.target)
    if id then
      return note_link(id, el.content)
    end
    el.target = target
    return el
  end,

  Image = function(el)
    el.src = rewrite_target(el.src)
    return el
  end,

  -- Bare "notation:ID" text, possibly with trailing punctuation.
  Str = function(el)
    local id, rest = el.text:match("^notation:(%d%d%d%d%d%d%d%d%d%d%d%d%d%d)(.*)$")
    if id then
      local link = note_link(id, { pandoc.Str("notation:" .. id) })
      if rest ~= "" then
        return { link, pandoc.Str(rest) }
      end
      return link
    end
  end,

  Span = function(el)
    local done = el.classes:includes("done")
    if done or el.classes:includes("todo") then
      local keyword = pandoc.utils.stringify(el)
      el.classes:insert("keyword")
      el.attributes.style = "--kw: var(" .. keyword_colour(keyword, done) .. ")"
      return el
    end
  end,

  Header = function(el)
    local rest, tags = pandoc.List(), pandoc.List()
    for _, inline in ipairs(el.content) do
      local priority = inline.t == "Str" and inline.text:match("^%[#(%w)%]$")
      if inline.t == "Span" and inline.classes:includes("tag") then
        tags:insert(pandoc.Span({ pandoc.Str(inline.attributes["tag-name"]) }, pandoc.Attr("", { "tag" })))
      elseif priority then
        rest:insert(pandoc.Span({ pandoc.Str(priority) },
          pandoc.Attr("", { "priority", "priority-" .. priority }, { title = "Priority " .. priority })))
      else
        rest:insert(inline)
      end
    end
    -- Drop the spaces that separated the tags.
    while #rest > 0 and (rest[#rest].t == "Space" or (rest[#rest].t == "Str" and rest[#rest].text == "\u{a0}")) do
      rest:remove()
    end
    if #tags > 0 then
      rest:insert(pandoc.Span(tags, pandoc.Attr("", { "tags" })))
    end
    el.content = rest
    return el
  end,

  Plain = function(el)
    local first = el.content[1]
    if first and first.t == "Strong" and PLANNING[pandoc.utils.stringify(first)] then
      return pandoc.Div({ el }, pandoc.Attr("", { "planning" }))
    end
  end,
}

local function escape_attr(s)
  return (s:gsub("&", "&amp;"):gsub('"', "&quot;"):gsub("<", "&lt;"))
end

local function is_done(header)
  for _, inline in ipairs(header.content) do
    if inline.t == "Span" and inline.classes:includes("done") then return true end
  end
  return false
end

-- Each heading and what follows it becomes <details><summary>heading</summary>...</details>.
local fold = {
  Div = function(div)
    local header = div.content[1]
    if not div.classes:includes("section") or not header or header.t ~= "Header" then return nil end
    local body = pandoc.List()
    for i = 2, #div.content do body:insert(div.content[i]) end
    local classes = "section level" .. header.level .. (#body == 0 and " empty" or "")
    local id = div.identifier ~= "" and (' id="' .. escape_attr(div.identifier) .. '"') or ""
    local open = (#body == 0 or not (folded or is_done(header))) and " open" or ""
    local blocks = pandoc.List({
      pandoc.RawBlock("html", '<details class="' .. classes .. '"' .. id .. open .. "><summary>"),
      header,
      pandoc.RawBlock("html", "</summary>"),
    })
    blocks:extend(body)
    blocks:insert(pandoc.RawBlock("html", "</details>"))
    return blocks
  end,
}

function Pandoc(doc)
  if doc.meta.notation_id then
    note_id = pandoc.utils.stringify(doc.meta.notation_id)
  end
  folded = doc.meta.notation_folded ~= nil
  doc = doc:walk(filter)
  doc.blocks = pandoc.structure.make_sections(doc.blocks, {})
  return doc:walk(fold)
end
