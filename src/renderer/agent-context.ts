import { createContext } from "react";

/** Project Code sessions can drill from a thread row into their panel; chats keep details in the thread. */
export const AgentSession = createContext<string | undefined>(undefined);
