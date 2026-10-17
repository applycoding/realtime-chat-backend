import { errorMessage } from "./errors.js";

type Fields = Record<string, unknown>;

function write(level: "info" | "error", msg: string, fields?: Fields): void {
  const line = JSON.stringify({
    time: new Date().toISOString(),
    level,
    msg,
    ...fields,
  });
  if (level === "error") {
    console.error(line);
    return;
  }
  console.log(line);
}

export const log = {
  info(msg: string, fields?: Fields): void {
    write("info", msg, fields);
  },
  error(msg: string, err?: unknown, fields?: Fields): void {
    write("error", msg, { ...fields, err: err === undefined ? undefined : errorMessage(err) });
  },
};
