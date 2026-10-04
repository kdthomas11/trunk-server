import { sourceLabel, callTags } from "./sourceTags";

describe("sourceLabel", () => {
  it("prefers the callsign a D-Star / YSF radio sent", () => {
    expect(sourceLabel({ pos: 0, src: "-1", tag: "N6KEN/ID-52" })).toBe("N6KEN/ID-52");
  });

  it("falls back to the radio ID", () => {
    expect(sourceLabel({ pos: 0, src: "1234" })).toBe("1234");
  });
});

describe("callTags", () => {
  it("lists each callsign once, in the order they keyed up", () => {
    const call = { srcList: [
      { pos: 0, src: "-1", tag: "N6KEN/ID-52" },
      { pos: 4, src: "-1", tag: "W6EK" },
      { pos: 9, src: "-1", tag: "N6KEN/ID-52" },
      { pos: 12, src: "-1" }
    ] };
    expect(callTags(call)).toEqual(["N6KEN/ID-52", "W6EK"]);
  });

  it("is empty for a call with no tags", () => {
    expect(callTags({ srcList: [{ pos: 0, src: "-1" }] })).toEqual([]);
    expect(callTags({})).toEqual([]);
  });
});
