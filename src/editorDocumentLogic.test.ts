import { expect, it, vi } from "vitest";
import { DocumentConflict, EditorDocumentClient } from "./editorDocumentLogic";

it("does not replace newer configuration with a delayed read", async () => {
  let resolve!: (value: unknown) => void;
  const ipc = vi.fn().mockImplementationOnce(() => new Promise(yes => { resolve = yes; })).mockResolvedValue({revision:2,content:'new'});
  const client = new EditorDocumentClient("monitor", ipc), changes = vi.fn(); client.subscribe(changes);
  const old = client.read();
  await client.read();
  resolve({revision:1,content:'old'});
  expect(await old).toEqual({revision:2,content:'new'});
  expect(changes).toHaveBeenCalledTimes(1);
});

it("reports a concurrent write conflict, refreshes the reader, and does not retry a stale replacement", async () => {
  const ipc = vi.fn().mockResolvedValueOnce({revision:1,content:'old'})
    .mockResolvedValueOnce({accepted:false,snapshot:{revision:2,content:'other window'}});
  const client = new EditorDocumentClient("monitor",ipc), changes = vi.fn();client.subscribe(changes);
  await expect(client.change(()=>'stale replacement')).rejects.toBeInstanceOf(DocumentConflict);
  expect(ipc).toHaveBeenCalledTimes(2);
  expect(changes).toHaveBeenLastCalledWith({revision:2,content:'other window'});
  ipc.mockResolvedValueOnce({revision:2,content:'other window'});
  await expect(client.change(()=>'stale draft',1)).rejects.toBeInstanceOf(DocumentConflict);
  expect(ipc).toHaveBeenCalledTimes(3);
});

it("serializes edits while preserving other fields and does not write after a read failure", async () => {
  let snapshot={revision:0,content:'{}'};
  const ipc=vi.fn().mockImplementation(async(command:string,args:any)=>{
    if(command==='editor_document_read')return {...snapshot};
    expect(args.expected).toBe(snapshot.revision);
    snapshot={revision:snapshot.revision+1,content:args.content};
    return {accepted:true,snapshot:{...snapshot}};
  });
  const client=new EditorDocumentClient('monitor',ipc);
  await Promise.all([client.change(raw=>JSON.stringify({...JSON.parse(raw!),a:1})),client.change(raw=>JSON.stringify({...JSON.parse(raw!),b:2}))]);
  expect(JSON.parse(snapshot.content)).toEqual({a:1,b:2});
  ipc.mockRejectedValueOnce(new Error('disk read'));
  const count=ipc.mock.calls.length;
  await expect(client.change(()=>'bad')).rejects.toThrow('disk read');
  expect(ipc.mock.calls.length).toBe(count+1);
});

it("bounds the pending edit queue while a read is stalled", async () => {
  let release!: (value: unknown) => void;
  const ipc = vi.fn().mockImplementationOnce(() => new Promise(yes => { release = yes; }))
    .mockResolvedValue({ revision: 0, content: "{}" });
  const client = new EditorDocumentClient("monitor", ipc);
  const pending = Array.from({length:32}, () => client.change(raw => raw!));
  await expect(client.change(() => "overflow")).rejects.toThrow("队列已满");
  release({revision:0,content:"{}"});
  await Promise.all(pending);
  expect(ipc.mock.calls.every(([command]) => command === "editor_document_read")).toBe(true);
});
