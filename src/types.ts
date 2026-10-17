export type PublicUser = {
  id: string;
  username: string;
};

export type RoomKind = "room" | "dm";

export type PublicRoom = {
  id: string;
  name: string | null;
  kind: RoomKind;
  createdAt: string;
};

export type PublicMessage = {
  id: string;
  roomId: string;
  senderId: string;
  username: string;
  body: string;
  clientMsgId: string | null;
  createdAt: string;
};

export type ReadReceipt = {
  userId: string;
  username: string;
  messageId: string;
  readAt: string;
};
