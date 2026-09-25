import { asOptionalRecord as readRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

type IstWord = { w?: string; sc?: number };
type IstWs = { cw?: IstWord[] };
type IstResult = {
  pgs?: string;
  ws?: IstWs[];
  ls?: boolean;
};
type IstPayload = {
  code?: number;
  message?: string;
  data?: {
    status?: number;
    result?: IstResult;
  };
};

function readIstWords(result: IstResult | undefined): string {
  if (!result?.ws?.length) {
    return "";
  }
  return result.ws
    .flatMap((segment) => segment.cw ?? [])
    .map((word) => word.w ?? "")
    .join("");
}

export function parseIstSpMessage(payload: unknown):
  | {
      text: string;
      partial: boolean;
      final: boolean;
      error?: string;
    }
  | undefined {
  const record = readRecord(payload) as IstPayload | undefined;
  if (!record) {
    return undefined;
  }
  if (record.code !== undefined && record.code !== 0) {
    return {
      text: "",
      partial: false,
      final: true,
      error: record.message?.trim() || `XFYun IST-SP failed (code=${record.code})`,
    };
  }
  const result = record.data?.result;
  const text = readIstWords(result);
  if (!text) {
    return undefined;
  }
  const partial = result?.pgs === "apd";
  const final = result?.ls === true || record.data?.status === 2;
  return { text, partial, final };
}
