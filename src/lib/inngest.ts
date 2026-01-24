import { Inngest } from 'inngest';

// Tipos dos eventos
type Events = {
  'whatsapp/message.received': {
    data: {
      threadId: string;
      organizationId: string;
      messageId: string;
      contactId: string;
    };
  };
  'whatsapp/send.message': {
    data: {
      threadId: string;
      organizationId: string;
      content: string;
      buttons?: { id: string; title: string }[];
    };
  };
  'ai/process.followup': {
    data: {
      threadId: string;
      organizationId: string;
      delayHours: number;
    };
  };
};

// Cliente Inngest
export const inngest = new Inngest({ 
  id: 'seialz',
  eventKey: process.env.INNGEST_EVENT_KEY,
});

export type { Events };
