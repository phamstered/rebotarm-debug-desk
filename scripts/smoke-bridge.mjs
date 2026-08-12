const port = Number(process.argv[2] ?? 18765);
const socket = new WebSocket(`ws://127.0.0.1:${port}`);
const timer = setTimeout(() => {
  console.error("Bridge smoke test timed out");
  process.exit(1);
}, 8000);

socket.addEventListener("open", () => {
  socket.send(JSON.stringify({ op: "topics", request_id: "smoke-test" }));
});
socket.addEventListener("message", (event) => {
  const message = JSON.parse(String(event.data));
  if (message.op !== "topics") return;
  console.log(`Bridge OK: ${message.topics.length} topics`);
  for (const topic of message.topics) console.log(`${topic.name} [${topic.types.join(", ")}]`);
  clearTimeout(timer);
  socket.close();
});

socket.addEventListener("error", () => {
  clearTimeout(timer);
  console.error(`Cannot connect to ws://127.0.0.1:${port}`);
  process.exit(1);
});
