import { asOptionalRecord as readRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

type RtasrWord = { w?: string };
type RtasrWordSegment = { cw?: RtasrWord[] };
type RtasrRtSegment = { ws?: RtasrWordSegment[] };
type RtasrSt = { rt?: RtasrRtSegment[]; type?: string };
type RtasrCn = { st?: RtasrSt };
type RtasrPayload = {
  msg_type?: string;
  res_type?: string;
  data?: {
    ls?: boolean;
    cn?: RtasrCn;
    desc?: string;
    normal?: boolean;
  };
};

function readWordsFromRt(rt: RtasrRtSegment[] | undefined): string {
  if (!rt?.length) {
    return "";
  }
  const parts: string[] = [];
  for (const segment of rt) {
    for (const ws of segment.ws ?? []) {
      for (const cw of ws.cw ?? []) {
        if (cw.w) {
          parts.push(cw.w);
        }
      }
    }
  }
  return parts.join("");
}

export function parseRtasrLlmMessage(payload: unknown):
  | {
      text: string;
      partial: boolean;
      final: boolean;
      error?: string;
    }
  | undefined {
  const record = readRecord(payload) as RtasrPayload | undefined;
  if (!record) {
    return undefined;
  }
  if (record.msg_type === "result" && record.res_type === "frc") {
    return {
      text: "",
      partial: false,
      final: true,
      error: record.data?.desc ?? "XFYun RTASR forced result close",
    };
  }
  if (record.msg_type !== "result" || record.res_type !== "asr" || !record.data) {
    return undefined;
  }
  const text = readWordsFromRt(record.data.cn?.st?.rt);
  if (!text) {
    return undefined;
  }
  const segmentType = record.data.cn?.st?.type;
  const partial = segmentType === "1";
  const final = record.data.ls === true || segmentType === "0";
  return { text, partial, final };
}
