// Each srcList entry is { pos, src, tag }. src is a radio ID, which only trunked
// systems have - a conventional repeater sends -1. tag is the name trunk-recorder
// gave whoever keyed up: a unit alias, or on D-Star and YSF the callsign the
// radio sent in its header (for example N6KEN/ID-52).

// What to call one source: its tag when it has one, otherwise its radio ID.
export function sourceLabel(source) {
  return (source && source.tag) || (source ? source.src : "-");
}

// The distinct tags heard on a call, in the order they first keyed up.
export function callTags(call) {
  const tags = [];
  for (const source of (call && call.srcList) || []) {
    if (source.tag && !tags.includes(source.tag)) {
      tags.push(source.tag);
    }
  }
  return tags;
}
