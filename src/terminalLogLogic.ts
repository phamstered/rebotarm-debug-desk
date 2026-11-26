import { invoke } from '@tauri-apps/api/core';
import { emit } from '@tauri-apps/api/event';
import { useEffect, useRef } from 'react';
import { nativeDesktop } from './nativeWorkspaceLogic';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type TerminalInput = { source: string; level: LogLevel; task?: string; message: string; key?: string; failure?: { key: string; title: string; summary?:string } };
export type TerminalEntry = TerminalInput & { id: number; time: number; session: string; host: string; task: string };
export type TerminalPage = { entries: TerminalEntry[]; cursor: number; latest: number; session: string; host: string; truncated: boolean; sessions: Record<string, string>; archive_dropped: number; archive_error?: string };
export type TerminalFilter = { session: string; source: string; level: string; task: string; search: string; after: number };
let session = 'local', seq = 0;
let local: TerminalEntry[] = [];
const sizes = new WeakMap<TerminalEntry, number>();
const queue: { session: string | null; entry: TerminalInput }[] = [];
let flushing = false, dropped = 0;
export function terminalSession() { return session; }
export function logLevel(message: string): LogLevel {
  message=message.replace(/\berror(?:_code)?\s*[=:]\s*0\b/gi, "");
  return /\b(error|fatal)\b|失败|异常/i.test(message) ? 'error' : /\bwarn(?:ing)?\b|未确认|待核验/i.test(message) ? 'warn' : 'info';
}
/** A current failure reason may stay beside its control; full output stays in Terminal. */
export function operationFailureSummary(message: string) {
  const line = message.split(/\r?\n/).find(value => value.trim())?.trim() ?? "操作失败";
  const characters = Array.from(line);
  return characters.length > 180 ? characters.slice(0, 180).join("") + "…" : line;
}
/** Apply both limits in each consumer, independently of native retention. */
export function retainTerminal(entries: TerminalEntry[]) {
  let bytes = 0, start = entries.length;
  while (start > 0 && entries.length - start < 20000) {
    const entry=entries[start-1];
    const size = sizes.get(entry) ?? new TextEncoder().encode(JSON.stringify(entry)).length;
    sizes.set(entry,size);
    if (bytes + size > 20 * 1024 * 1024) break;
    bytes += size; start--;
  }
  return entries.slice(start);
}
export function terminalPublish(entry: TerminalInput, context?: string) {
  if (!entry.message.trim()) return;
  let message=entry.message.slice(0,16000);
  if(message.length<entry.message.length){if(/[\uD800-\uDBFF]$/.test(message))message=message.slice(0,-1);message+='…[前端截断]';}
  const bounded = { ...entry, message, task: entry.task?.slice(0, 200) };
  if (!nativeDesktop()) {
    const row = { ...bounded, id: ++seq, time: Date.now(), session: context ?? session, host: '本地', task: entry.task ?? '' };
    local = retainTerminal([...local, row]);
    if (entry.failure) window.dispatchEvent(new CustomEvent('operation-failure', {detail:{entry:row,...entry.failure}}));
    return;
  }
  if (queue.length >= 256) { queue.shift(); dropped++; }
  queue.push({ session: context ?? null, entry: bounded });
  void flush();
}
async function flush() {
  if (flushing) return;
  flushing = true;
  try {
    while (queue.length) {
      const context = queue[0].session, entries: TerminalInput[] = [];
      while (queue.length && queue[0].session === context && entries.length < 128) entries.push(queue.shift()!.entry);
      if (dropped) { entries.push({ source: 'System', level: 'warn', message: `前端日志队列溢出，丢弃 ${dropped} 条` }); dropped = 0; }
      try {
        const rows = await invoke<(TerminalEntry | null)[]>('terminal_append', { session: context, entries: entries.map(({failure: _failure, ...row})=>row) });
        for (const [i, input] of entries.entries()) if (input.failure && rows?.[i]) {
          void invoke('notification_show', {id:rows[i]!.id,key:input.failure.key,heading:input.failure.title,summary:input.failure.summary??null}).catch(error=>window.dispatchEvent(new CustomEvent('terminal-error',{detail:`错误浮层不可用，详情仍在 Terminal：${String(error)}`})));
        }
      }
      catch (error) { window.dispatchEvent(new CustomEvent('terminal-error', { detail: `日志写入失败：${String(error)}` })); }
    }
  } finally { flushing = false; }
}
export async function readTerminal(after: number): Promise<TerminalPage> {
  if (!nativeDesktop()) {
    const entries = local.filter(e => e.id > after).slice(0, 256);
    return { entries, cursor: entries.at(-1)?.id ?? after, latest: seq, session: 'local', host: '本地', sessions: { local: '本地' }, truncated: Boolean(local[0] && after + 1 < local[0].id), archive_dropped: 0 };
  }
  const page = await invoke<TerminalPage>('terminal_read', { after });
  if (!page || !Array.isArray(page.entries) || typeof page.session !== 'string') throw new Error('日志服务响应无效');
  session = page.session;
  return page;
}
export function useTerminalMessage(source: string, message: string | null | undefined, level?: LogLevel, task = '') {
  const last = useRef('');
  const mounted = useRef(false);
  useEffect(() => {
    const initial = !mounted.current; mounted.current = true;
    const key = JSON.stringify([session, source, task, level, message]);
    if (!message) { last.current = ''; return; }
    if (last.current === key) return;
    last.current = key;
    terminalPublish({ source, message, level: level ?? logLevel(message), task,
      failure: !initial && level === 'error' ? {key:task || crypto.randomUUID(),title:`${source} · 操作失败`} : undefined });
  }, [source, message, level, task]);
}
export function useTerminalLines(source: string, lines: readonly string[], task = '') {
  const previous = useRef<{ key: string; lines: readonly string[] }>({ key: '', lines: [] });
  useEffect(() => {
    const key = `${source}:${task}:${session}`;
    const before = previous.current.key === key ? previous.current.lines : [];
    let overlap = Math.min(before.length, lines.length);
    while (overlap > 0 && !before.slice(-overlap).every((line, i) => line === lines[i])) overlap--;
    for (const message of lines.slice(overlap)) terminalPublish({ source, task, message, level: logLevel(message) });
    previous.current = { key, lines: [...lines] };
  }, [source, lines, task]);
}
export function openTerminal(source?: string, task?: string, target="main", entry?: TerminalEntry) {
  const detail = { source, task, target, ...(entry ? {entry} : {}) };
  if (nativeDesktop()) void emit('terminal-open', detail).catch(error => window.dispatchEvent(new CustomEvent('terminal-error', { detail: String(error) })));
  else window.dispatchEvent(new CustomEvent('terminal-open', { detail }));
}
export function formatTerminal(entry: TerminalEntry) {
  return `${entry.time} [${entry.level.toUpperCase()}] [${entry.host}] [${entry.source}] [${entry.task}] ${entry.message}`;
}
export function filterTerminal(entries: TerminalEntry[], filter: TerminalFilter) {
  const query = filter.search.toLowerCase();
  return entries.filter(e => e.id > filter.after && (!filter.session || e.session === filter.session) && (!filter.source || e.source === filter.source)
    && (!filter.level || (filter.level === 'info+' ? e.level !== 'debug' : e.level === filter.level)) && (!filter.task || e.task === filter.task)
    && (!query || formatTerminal(e).toLowerCase().includes(query)));
}

/** Explicit failure event: call once at the operation boundary, never from log parsing. */
export function reportOperationFailure(source:string, message:string, options:{key?:string;title?:string;summary?:string;task?:string;session?:string}={}) {
 terminalPublish({source,message,level:'error',task:options.task,failure:{key:options.key??crypto.randomUUID(),title:options.title??`${source} · 操作失败`,summary:options.summary}},options.session);
}
