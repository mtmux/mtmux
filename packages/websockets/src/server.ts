import { Server as HttpServer } from "node:http";
import { Server } from "socket.io";
import type {
  ServerToClientEvents,
  ClientToServerEvents,
  InterServerEvents,
  SocketData,
} from "./events";

export type TypedServer = Server<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>;

export function createSocketServer(httpServer: HttpServer, cors?: { origin: string | string[] }): TypedServer {
  const io: TypedServer = new Server(httpServer, {
    cors: cors ?? {
      origin: ["http://localhost:14100", "http://localhost:14101"],
      methods: ["GET", "POST"],
    },
  });

  io.on("connection", (socket) => {
    console.log(`Socket connected: ${socket.id}`);

    socket.on("subscribe:project", (projectId) => {
      socket.join(`project:${projectId}`);
    });

    socket.on("unsubscribe:project", (projectId) => {
      socket.leave(`project:${projectId}`);
    });

    socket.on("disconnect", () => {
      console.log(`Socket disconnected: ${socket.id}`);
    });
  });

  return io;
}
