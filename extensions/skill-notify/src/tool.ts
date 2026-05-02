// `notify` agent tool — actions: write | ack | list | get.

import { Type } from "typebox";
import { jsonResult, type OpenClawPluginApi } from "../api.js";
import type { NotifyConfig } from "./config.js";
import { dispatchNotification } from "./dispatch.js";
import { ackEntry, getEntry, listEntries, writeEntry } from "./ledger.js";
import type { AckResult, GetResult, ListResult, RunDeps, WriteResult } from "./types.js";

interface WriteParams {
  action: "write";
  event: string;
  channel: string;
  payload: unknown;
  ts?: string;
  meta?: Record<string, string>;
  dispatch?: boolean;
  severity?: "info" | "warn" | "critical";
  title?: string;
}

interface AckParams {
  action: "ack";
  notifId: string;
  method: string;
  ts?: string;
  note?: string;
  date?: string;
}

interface ListParams {
  action: "list";
  pending?: boolean;
  date?: string;
  limit?: number;
  all?: boolean;
}

interface GetParams {
  action: "get";
  notifId: string;
  date?: string;
}

type RawParams = WriteParams | AckParams | ListParams | GetParams;

export function createNotifyTool(_params: { api: OpenClawPluginApi; config: NotifyConfig }) {
  const config = _params.config;
  return {
    name: "notify",
    label: "Notify",
    description:
      "Verified-delivery notification surface. Wire-compatible with chuck-notify.mjs ledger schema (chuck-v3.notification-ledger/1). Actions: 'write' (record entry; if dispatch=true also send via the openclaw-bound channel — telegram or apple-bridge — and return per-channel receipt with telegram message_id), 'ack' (mark a previous notif as received with method/note), 'list' (today's or --date or --all entries; --pending to filter unack'd), 'get' (single entry by notif_id). The .mjs only writes the ledger; this tool also delivers.",
    parameters: Type.Object({
      action: Type.String({ enum: ["write", "ack", "list", "get"] }),
      event: Type.Optional(Type.String()),
      channel: Type.Optional(Type.String()),
      payload: Type.Optional(Type.Any()),
      ts: Type.Optional(Type.String()),
      meta: Type.Optional(Type.Record(Type.String(), Type.String())),
      dispatch: Type.Optional(Type.Boolean()),
      severity: Type.Optional(Type.String({ enum: ["info", "warn", "critical"] })),
      title: Type.Optional(Type.String()),
      notifId: Type.Optional(Type.String()),
      method: Type.Optional(Type.String()),
      note: Type.Optional(Type.String()),
      date: Type.Optional(Type.String()),
      pending: Type.Optional(Type.Boolean()),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
      all: Type.Optional(Type.Boolean()),
    }),
    async execute(_toolCallId: string, rawParams: Record<string, unknown>) {
      const raw = rawParams as unknown as RawParams;
      if (raw.action === "write") {
        const ts = raw.ts ? new Date(raw.ts) : new Date();
        const entry = writeEntry(config, {
          event: raw.event,
          channel: raw.channel,
          payload: raw.payload,
          ts,
          meta: raw.meta,
        });
        let dispatched: WriteResult["dispatched"] = [];
        if (raw.dispatch === true) {
          const title = raw.title ?? raw.event;
          const text =
            typeof raw.payload === "string"
              ? raw.payload
              : raw.payload != null
                ? JSON.stringify(raw.payload)
                : "";
          dispatched = await dispatchNotification(config, {
            channel: raw.channel,
            title,
            text,
            severity: raw.severity,
          });
        }
        const result: WriteResult = {
          ok: dispatched.every((d) => d.ok) && (raw.dispatch !== true || dispatched.length > 0),
          ledger: { notif_id: entry.notif_id, path: entry.path },
          dispatched,
        };
        return jsonResult(result);
      }
      if (raw.action === "ack") {
        const ts = raw.ts ? new Date(raw.ts) : undefined;
        const result = ackEntry(config, {
          notifId: raw.notifId,
          method: raw.method,
          ts,
          note: raw.note,
          date: raw.date,
        });
        const out: AckResult = {
          ok: true,
          notif_id: result.notif_id,
          ack_ts: result.entry.ack_ts ?? "",
          ack_method: result.entry.ack_method ?? "",
          path: result.path,
        };
        return jsonResult(out);
      }
      if (raw.action === "list") {
        const result = listEntries(config, {
          pending: raw.pending,
          date: raw.date,
          limit: raw.limit,
          all: raw.all,
        });
        const out: ListResult = { ok: true, entries: result.entries };
        return jsonResult(out);
      }
      if (raw.action === "get") {
        const result = getEntry(config, raw.notifId, raw.date);
        const out: GetResult = { ok: true, entry: result.entry, path: result.path };
        return jsonResult(out);
      }
      const action = (raw as { action: string }).action;
      throw new Error(`unknown notify action: ${action}`);
    },
  };
}
