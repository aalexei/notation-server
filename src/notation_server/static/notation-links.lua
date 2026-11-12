-- Pandoc filter: point links at the notation server.
--
--   notation:ID          -> /note/ID  (as a link the frontend intercepts)
--   relative paths       -> /files/<note id>/<path>  (attachments, images)
--
-- The id of the note being rendered comes from the `notation_id' metadata
-- field, set on the command line with -M notation_id=...

local note_id = ""

local function is_relative(target)
  return not (target:match("^%a[%w+.-]*:") or target:match("^/") or target:match("^#"))
end

local function rewrite_target(target)
  local id = target:match("^notation:(%d%d%d%d%d%d%d%d%d%d%d%d%d%d)$")
  if id then
    return "/note/" .. id, id
  end
  target = target:gsub("^file:", "")
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
}

function Pandoc(doc)
  if doc.meta.notation_id then
    note_id = pandoc.utils.stringify(doc.meta.notation_id)
  end
  return doc:walk(filter)
end
