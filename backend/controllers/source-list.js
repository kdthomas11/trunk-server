// A D-Star callsign is 8 characters plus a 4 character suffix; this leaves room
// for longer unit aliases without letting an uploader store an essay per source.
const MAX_SOURCE_TAG = 32;

// source_list is whatever the uploader sent. Keep the three fields we use, and
// treat tag as untrusted text: on D-Star and YSF it was decoded off the air.
function clean_src_list(list) {
  if (!Array.isArray(list)) return [];
  return list.map(source => {
    const entry = { pos: Number(source.pos) || 0, src: String(source.src) };
    const tag = typeof source.tag === 'string' ? source.tag.trim().slice(0, MAX_SOURCE_TAG) : '';
    if (tag) entry.tag = tag;
    return entry;
  });
}

module.exports = { clean_src_list, MAX_SOURCE_TAG };
