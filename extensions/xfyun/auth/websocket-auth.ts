import { createHmac, randomUUID } from "node:crypto";

export type XfyunWsAuthParams = {
  host: string;
  path: string;
  apiKey: string;
  apiSecret: string;
  baseUrl: string;
};

function buildSignatureOrigin(host: string, date: string, requestLine: string): string {
  return `host: ${host}\ndate: ${date}\n${requestLine}`;
}

export function buildXfyunHmacSha256WsUrl(params: XfyunWsAuthParams, date = new Date()): string {
  const url = new URL(params.baseUrl);
  const host = params.host || url.host;
  const path = params.path || url.pathname;
  const dateHeader = date.toUTCString();
  const requestLine = `GET ${path} HTTP/1.1`;
  const signatureOrigin = buildSignatureOrigin(host, dateHeader, requestLine);
  const signature = createHmac("sha256", params.apiSecret).update(signatureOrigin).digest("base64");
  const authorizationOrigin = [
    `api_key="${params.apiKey}"`,
    'algorithm="hmac-sha256"',
    'headers="host date request-line"',
    `signature="${signature}"`,
  ].join(", ");
  const authorization = Buffer.from(authorizationOrigin).toString("base64");
  url.searchParams.set("authorization", authorization);
  url.searchParams.set("date", dateHeader);
  url.searchParams.set("host", host);
  return url.toString();
}

export function formatRtasrUtc(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absolute = Math.abs(offsetMinutes);
  const hours = pad(Math.floor(absolute / 60));
  const minutes = pad(absolute % 60);
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${hours}${minutes}`
  );
}

export function buildRtasrLlmWsUrl(params: {
  baseUrl: string;
  appId: string;
  accessKeyId: string;
  accessKeySecret: string;
  query: Record<string, string>;
  uuid?: string;
  utc?: string;
}): string {
  const url = new URL(params.baseUrl);
  const utc = params.utc ?? formatRtasrUtc();
  const uuid = params.uuid ?? randomUUID();
  const entries: Array<[string, string]> = [
    ["accessKeyId", params.accessKeyId],
    ["appId", params.appId],
    ["uuid", uuid],
    ["utc", utc],
    ...Object.entries(params.query).filter(([, value]) => value.length > 0),
  ];
  entries.sort(([left], [right]) => left.localeCompare(right));
  const baseString = entries
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
  const signature = createHmac("sha1", params.accessKeySecret).update(baseString).digest("base64");
  for (const [key, value] of entries) {
    url.searchParams.set(key, value);
  }
  url.searchParams.set("signature", signature);
  return url.toString();
}
