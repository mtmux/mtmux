export interface ServerToClientEvents {
  notification: (data: { title: string; message: string; type: "info" | "success" | "warning" | "error" }) => void;
  "user:online": (data: { userId: string }) => void;
  "user:offline": (data: { userId: string }) => void;
  "project:updated": (data: { projectId: string; updatedBy: string }) => void;
}

export interface ClientToServerEvents {
  "subscribe:project": (projectId: string) => void;
  "unsubscribe:project": (projectId: string) => void;
  "presence:ping": () => void;
}

export interface InterServerEvents {
  ping: () => void;
}

export interface SocketData {
  userId: string;
  sessionId: string;
}
