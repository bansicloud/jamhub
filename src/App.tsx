import React, { useState, useContext, useEffect, useRef } from "react";
import * as Tone from "tone";

import { User, Room, pingEvent, TransportEvent, delay } from "./lib";

import { Subject, of, Observable } from "rxjs";
import { mergeMap } from "rxjs/operators";
// import { LoggerEvent } from "./lib.ts";

import { Piano } from "@tonejs/piano";
import { Reverb } from "tone";

import { Keyboard } from "./Keyboard";

// const piano = new Piano({
//   velocities: 5,
// });

// //connect it to the speaker output
// const reverb = new Reverb({
//   decay: 5,
//   wet: 0.5,
// });

// piano.connect(reverb);
// reverb.toDestination();
const synth = new Tone.Synth({
  oscillator: {
    type: "sine",
  },
  envelope: {
    attack: 0.005,
    decay: 0.1,
    sustain: 0.3,
    release: 1,
  },
}).toDestination();

export interface State {
  isMutedMicrophone: boolean;
  isMutedSpeaker: boolean;
  user?: User;
  room: Room;
}

interface Api {
  roomUserAdd: (user: User) => void;
  roomUserRemove: (user: User) => void;
  roomUserUpdate: (user: User) => void;
}
interface Store {
  state: State;
  update: (partial: Partial<State>) => void;
  api: Api;
}
const defaultState: State = {
  isMutedMicrophone: true,
  isMutedSpeaker: false,
  room: {
    users: [],
  },
};

const StoreContext = React.createContext<Store | undefined>(undefined);
export const StoreProvider: React.FC = ({ children }) => {
  const [state, setState] = useState<State>(defaultState);
  const update = (partial: Partial<State>) =>
    setState({ ...state, ...partial });

  const updateRoom = (partial: Partial<Room>): void => {
    return update({ room: { ...state.room, ...partial } });
  };
  const api: Api = {
    roomUserAdd: (user) => {
      updateRoom({ users: [...state.room.users, user] });
    },
    roomUserRemove: (user) => {
      return updateRoom({
        users: state.room.users.filter((roomUser) => roomUser.id !== user.id),
      });
    },
    roomUserUpdate: (user) => {
      return updateRoom({
        users: state.room.users.map((roomUser) => {
          if (user.id === roomUser.id) {
            return { ...roomUser, ...user };
          }
          return roomUser;
        }),
      });
    },
  };
  return (
    <StoreContext.Provider
      value={{
        state,
        update,
        api,
      }}
    >
      {children}
    </StoreContext.Provider>
  );
};
export const useStore = (): Store => {
  const context = useContext(StoreContext);
  return context as Store; // store is defined anyway
};

export type MIDIEvent = [number, number, number];
// interface TransportEvent {
//   // note: string;
//   midi: MIDIEvent;
// }

interface LoggerEventConnectionStatus {
  type: "connectionStatus";
  status: TransportStatus;
}
interface LoggerEventPing {
  type: "ping";
  value: number; // ms
}

type LoggerEvent = LoggerEventConnectionStatus | LoggerEventPing;
type TransportStatus = "disconnected" | "connecting" | "connected" | "error";

interface Transport {
  send: (event: TransportEvent) => void;
  connect: () => { disconnect: () => void };
  events: Observable<LoggerEvent>;
}

interface Player {
  send: (event: TransportEvent) => void;
}

const createPlayer = (): Player => {
  return {
    send: (event: TransportEvent) => {
      if (event.type === "midi") {
        console.log("player", event, event.midi);
        // synth.triggerAttackRelease("C4", "8n");
        // synth.triggerAttackRelease(event.note, "8n");
        const [type, pitch, velocity] = event.midi;

        if (type === 144) {
          synth.triggerAttackRelease(
            Tone.Frequency(pitch, "midi").toNote(),
            "16n"
          );
        }
      }

      // if (type === 144) {
      //   piano.keyDown({ midi: pitch, velocity: velocity / 256 });
      // } else if (type === 128) {
      //   piano.keyUp({ midi: pitch });
      // }
    },
  };
};

const createLocalTransport = ({ player }: { player: Player }): Transport => {
  const stream = new Subject<TransportEvent>();
  const events = new Subject<LoggerEvent>();
  stream.subscribe((event) => player.send(event));
  return {
    send: (event: TransportEvent) => {
      stream.next(event);
    },
    connect: () => {
      events.next({ type: "connectionStatus", status: "connected" });
      return {
        disconnect: () => {
          events.next({ type: "connectionStatus", status: "disconnected" });
        },
      };
    },
    events: events.asObservable(),
  };
};

const createWebSocketTransport = ({
  url,
  player,
}: {
  url: string;
  player: Player;
}): Transport => {
  const send = new Subject<TransportEvent>();
  const receive = new Subject<TransportEvent>();
  const events = new Subject<LoggerEvent>();
  let lastSentEventTimestamp: number = Date.now();
  return {
    send: (event: TransportEvent) => {
      send.next(event);
    },
    connect: () => {
      events.next({ type: "connectionStatus", status: "connecting" });
      const sock = new WebSocket(url);
      // send/receieve data pipelines
      const sendPipeline = send.pipe(
        mergeMap((event) => {
          sock.send(JSON.stringify(event));
          return of(event);
        })
      );
      const receivePipeline = receive.pipe(
        mergeMap((event) => {
          player.send(event);
          return of(event);
        })
      );

      sock.onopen = async () => {
        sendPipeline.subscribe();
        receivePipeline.subscribe();
        events.next({ type: "connectionStatus", status: "connected" });

        while (true) {
          await delay(5000);
          lastSentEventTimestamp = Date.now();
          sock.send(JSON.stringify(pingEvent));
        }
      };
      sock.onclose = () => {
        events.next({ type: "connectionStatus", status: "disconnected" });
      };
      sock.onerror = (error) => {
        console.error(error);
        events.next({ type: "connectionStatus", status: "error" });
      };
      sock.onmessage = async (msg) => {
        const event = JSON.parse(msg.data) as TransportEvent;
        console.log("onmessage", event);
        receive.next(event);
        if (event.type === "pong") {
          events.next({
            type: "ping",
            value: Date.now() - lastSentEventTimestamp,
          });
        }
      };
      return {
        disconnect: () => {
          send.complete();
          receive.complete();
          sock.close();
        },
      };
    },
    events: events.asObservable(),
  };
};

const player = createPlayer();
const webSocketTransport = createWebSocketTransport({
  player,
  url: `wss://api.jambox.online${window.location.pathname}`,
  // url: "ws://localhost:8080/123",
});

const App: React.FC = () => {
  // const transport = createLocalTransport({ player });
  const transport = webSocketTransport;
  const [transportStatus, setTransportStatus] = useState<TransportStatus>(
    "disconnected"
  );
  const [pianoStatus, setPianoStatus] = useState<
    "not loaded" | "loading" | "ready"
  >("not loaded");
  const [ping, setPing] = useState<number>(0);

  useEffect(() => {
    // setPianoStatus("loading");
    // piano.load().then(() => {
    //   setPianoStatus("ready");
    //   console.log("loaded!");
    // });

    const listener = transport.events
      .pipe(
        mergeMap((event) => {
          console.log(event);
          if (event.type === "connectionStatus") {
            setTransportStatus(event.status);
          } else if (event.type === "ping") {
            setPing(event.value);
          }
          return of(event);
        })
      )
      .subscribe();
    return () => {
      listener.unsubscribe();
    };
  }, []);

  useEffect(() => {
    const conn = transport.connect();
    return () => {
      conn.disconnect();
    };
  }, []);

  useEffect(() => {
    const handleMidiEvent = (midiEvent: Event & { data: MIDIEvent }) => {
      const [type, pitch, velocity] = midiEvent.data;
      console.log(midiEvent.data);

      if (type === 144) {
        // note on
        transport.send({ type: "midi", midi: [type, pitch, velocity] });
      } else if (type === 128) {
        // note off
        transport.send({ type: "midi", midi: [type, pitch, velocity] });
      }
    };
    const tryAccessMidi = async (): Promise<void> => {
      try {
        if (typeof (navigator as any).requestMIDIAccess === "undefined") {
          throw new Error("midi is not supported");
        }
        const midiAccess = await (navigator as any).requestMIDIAccess();
        for (const midiInput of midiAccess.inputs.values()) {
          midiInput.onmidimessage = handleMidiEvent;
        }
      } catch (error) {
        console.error("Could not access your MIDI devices.", error);
      }
    };
    tryAccessMidi();
  });

  // useEffect(() => {
  //   setInterval(() => {
  //     console.log("tick");
  //     transport.send({ midi: [144, 108, 0.2] });
  //     transport.send({ midi: [128, 108, 0.2] });
  //     // 666.6666
  //   }, 666.6666);
  // }, []);

  return (
    <div>
      <Keyboard
        onMIDIEvent={(event) => {
          console.log(event);
          transport.send({ type: "midi", midi: event });
        }}
      />
      <div>
        transport:{" "}
        <span
          style={{
            ...(transportStatus === "connected" && { color: "green" }),
            ...(transportStatus === "error" && { color: "red" }),
            // color: transportStatus === "connected" ? "green" : "black",
          }}
        >
          {transportStatus}
        </span>
      </div>
      <div>piano: {pianoStatus}</div>
      <div>ping: {ping}ms</div>
      <div>v0.0.2</div>
    </div>
  );
};

export default App;

const assert = (expression: boolean, error: string): void => {
  if (!expression) {
    throw new Error(error);
  }
};
const uniq = (list: string[]): string[] => {
  return Object.keys(
    list.reduce((counts, name) => {
      return { ...counts, ...{ [name]: 1 } };
    }, {} as { [key: string]: number })
  );
};
