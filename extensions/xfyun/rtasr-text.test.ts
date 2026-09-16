import { describe, expect, it } from "vitest";
import { parseRtasrLlmMessage } from "./rtasr-text.js";

describe("xfyun RTASR text parsing", () => {
  it("extracts partial and final transcript segments", () => {
    const partial = parseRtasrLlmMessage({
      msg_type: "result",
      res_type: "asr",
      data: {
        ls: false,
        cn: {
          st: {
            type: "1",
            rt: [{ ws: [{ cw: [{ w: "你" }, { w: "好" }] }] }],
          },
        },
      },
    });
    expect(partial).toEqual({ text: "你好", partial: true, final: false });

    const final = parseRtasrLlmMessage({
      msg_type: "result",
      res_type: "asr",
      data: {
        ls: true,
        cn: {
          st: {
            type: "0",
            rt: [{ ws: [{ cw: [{ w: "你好" }] }] }],
          },
        },
      },
    });
    expect(final).toEqual({ text: "你好", partial: false, final: true });
  });
});
