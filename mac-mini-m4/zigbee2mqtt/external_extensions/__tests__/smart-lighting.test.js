'use strict';

// Mock external deps so the module loads without a real Z2M environment
jest.mock('fs', () => ({
    existsSync: jest.fn(() => false),
    readFileSync: jest.fn(() => { throw new Error('ENOENT'); }),
    writeFileSync: jest.fn(),
}));
jest.mock('mqtt', () => ({
    connect: jest.fn(() => ({
        on: jest.fn(),
        subscribe: jest.fn(),
        publish: jest.fn(),
        end: jest.fn(),
        connected: true,
    })),
}));

const SmartLighting = require('../smart-lighting');

// ── Minimal constructor mocks ────────────────────────────────────────────────

function makeInstance(configOverride) {
    const noop = () => {};
    const logger = { info: noop, warn: noop, error: noop, debug: noop };
    const eventBus = { onMQTTMessage: noop, removeListeners: noop };
    const settings = { get: () => ({ mqtt: { server: 'mqtt://localhost:1883' } }) };
    const sl = new SmartLighting(null, null, null, null, eventBus, null, null, null, settings, logger);
    sl.config = configOverride ?? null;
    sl.currentWindow = 'evening';
    return sl;
}

const BASE_CONFIG = {
    sl_enabled: true,
    house_mode: 'Home',
    rooms: {
        'Living Room': {
            lights: ['living_room_1'],
            smart_power_on: true,
            auto_transition: true,
            transition_secs: 0,
            motion_night: false,
            scenes: {
                morning: { brightness: 200, color_temp: 250 },
                day:     { brightness: 254, color_temp: 200 },
                evening: { brightness: 150, color_temp: 370 },
                night:   { brightness: 50,  color_temp: 454 },
            },
        },
        'Bedroom': {
            lights: ['bedroom_1', 'bedroom_2'],
            smart_power_on: true,
            auto_transition: true,
            transition_secs: 0,
            motion_night: true,
            scenes: {
                morning: { brightness: 180, color_temp: 280 },
                day:     { brightness: 220, color_temp: 220 },
                evening: { brightness: 100, color: { x: 0.37, y: 0.20 } },
                night:   { brightness: 30,  color_temp: 500 },
            },
        },
    },
};

// ── WINDOW_SCENE_ID mapping ──────────────────────────────────────────────────

describe('WINDOW_SCENE_ID', () => {
    const WINDOW_SCENE_ID = { morning: 1, day: 2, evening: 3, night: 4 };

    test('all four windows map to distinct IDs 1-4', () => {
        const ids = Object.values(WINDOW_SCENE_ID);
        expect(new Set(ids).size).toBe(4);
        expect(Math.min(...ids)).toBe(1);
        expect(Math.max(...ids)).toBe(4);
    });

    test('scene IDs match expected values', () => {
        expect(WINDOW_SCENE_ID.morning).toBe(1);
        expect(WINDOW_SCENE_ID.day).toBe(2);
        expect(WINDOW_SCENE_ID.evening).toBe(3);
        expect(WINDOW_SCENE_ID.night).toBe(4);
    });
});

// ── _buildScenePayload — pure scene values, no transition ───────────────────

describe('_buildScenePayload', () => {
    test('returns color_temp payload for CT scene', () => {
        const sl = makeInstance();
        const payload = sl._buildScenePayload('evening', BASE_CONFIG.rooms['Living Room']);
        expect(payload).toMatchObject({ state: 'ON', brightness: 150, color_temp: 370 });
        expect(payload.color).toBeUndefined();
    });

    test('returns xy color payload for XY scene', () => {
        const sl = makeInstance();
        const payload = sl._buildScenePayload('evening', BASE_CONFIG.rooms['Bedroom']);
        expect(payload).toMatchObject({ state: 'ON', brightness: 100, color: { x: 0.37, y: 0.20 } });
        expect(payload.color_temp).toBeUndefined();
    });

    test('returns brightness-only payload when no color info', () => {
        const sl = makeInstance();
        const roomConfig = {
            scenes: { morning: { brightness: 100 } },
            transition_secs: 0,
        };
        const payload = sl._buildScenePayload('morning', roomConfig);
        expect(payload).toMatchObject({ state: 'ON', brightness: 100 });
        expect(payload.color).toBeUndefined();
        expect(payload.color_temp).toBeUndefined();
    });

    test('returns null for missing window', () => {
        const sl = makeInstance();
        const payload = sl._buildScenePayload('evening', { scenes: {} });
        expect(payload).toBeNull();
    });

    test('never includes a transition field — that is _transition\'s job', () => {
        const sl = makeInstance();
        const roomConfig = {
            scenes: { morning: { brightness: 200, color_temp: 250 } },
            transition_secs: 30,
        };
        const payload = sl._buildScenePayload('morning', roomConfig);
        expect(payload.transition).toBeUndefined();
    });
});

// ── _transitionDurationSecs ───────────────────────────────────────────────────

describe('_transitionDurationSecs', () => {
    test('returns the configured value when positive', () => {
        const sl = makeInstance();
        expect(sl._transitionDurationSecs({ transition_secs: 3600 })).toBe(3600);
    });

    test('returns 0 when transition_secs is 0', () => {
        const sl = makeInstance();
        expect(sl._transitionDurationSecs({ transition_secs: 0 })).toBe(0);
    });

    test('returns 0 when transition_secs is missing/non-numeric', () => {
        const sl = makeInstance();
        expect(sl._transitionDurationSecs({})).toBe(0);
        expect(sl._transitionDurationSecs({ transition_secs: 'unknown' })).toBe(0);
    });

    test('returns 0 for a negative value (defensive, should never happen upstream)', () => {
        const sl = makeInstance();
        expect(sl._transitionDurationSecs({ transition_secs: -5 })).toBe(0);
    });
});

// ── _transition — the isolated, swappable fade seam (backend contract §1a) ──

describe('_transition', () => {
    test('sends direct command with transition field when duration > 0', () => {
        const sl = makeInstance();
        const sent = [];
        sl._sendCommand = (topic, payload) => sent.push({ topic, payload });

        const roomConfig = BASE_CONFIG.rooms['Living Room'];
        const result = sl._transition('Living Room', 'evening', roomConfig, 3600);

        expect(sent).toHaveLength(1);
        expect(sent[0].topic).toBe('Living Room/set');
        expect(sent[0].payload).toMatchObject({ state: 'ON', brightness: 150, color_temp: 370, transition: 3600 });
        expect(result).toEqual(sent[0].payload);
    });

    test('omits transition field when duration is 0 (instant)', () => {
        const sl = makeInstance();
        const sent = [];
        sl._sendCommand = (topic, payload) => sent.push({ topic, payload });

        sl._transition('Living Room', 'evening', BASE_CONFIG.rooms['Living Room'], 0);

        expect(sent[0].payload.transition).toBeUndefined();
    });

    test('returns null and sends nothing when the window has no scene', () => {
        const sl = makeInstance();
        const sent = [];
        sl._sendCommand = (topic, payload) => sent.push({ topic, payload });

        const result = sl._transition('Living Room', 'evening', { scenes: {} }, 3600);

        expect(result).toBeNull();
        expect(sent).toHaveLength(0);
    });

    test('preserves color/color_temp scene values alongside the transition field', () => {
        const sl = makeInstance();
        const sent = [];
        sl._sendCommand = (topic, payload) => sent.push({ topic, payload });

        sl._transition('Bedroom', 'evening', BASE_CONFIG.rooms['Bedroom'], 1800);

        expect(sent[0].payload).toMatchObject({ brightness: 100, color: { x: 0.37, y: 0.20 }, transition: 1800 });
    });
});

// ── scene_recall payloads (the flicker fix) ──────────────────────────────────

describe('_switchTurnRoomOn — uses scene_recall, not direct command', () => {
    test('sends scene_recall with correct scene ID for current window', () => {
        const sl = makeInstance(JSON.parse(JSON.stringify(BASE_CONFIG)));
        sl.currentWindow = 'evening';
        sl._switchLastScene = {};
        const sent = [];
        sl._sendCommand = (topic, payload) => sent.push({ topic, payload });

        sl._switchTurnRoomOn('Living Room');

        expect(sent).toHaveLength(1);
        expect(sent[0].topic).toBe('Living Room/set');
        expect(sent[0].payload).toEqual({ scene_recall: 3 }); // evening = 3
    });

    test('sends scene_recall ID 1 for morning window', () => {
        const sl = makeInstance(JSON.parse(JSON.stringify(BASE_CONFIG)));
        sl._switchLastScene = {};
        const sent = [];
        sl._sendCommand = (topic, payload) => sent.push({ topic, payload });

        // Override effective window to morning via config day_assignments + profiles
        // Simpler: spy on _getEffectiveWindow
        sl._getEffectiveWindow = () => 'morning';
        sl._switchTurnRoomOn('Bedroom');

        expect(sent[0].payload).toEqual({ scene_recall: 1 }); // morning = 1
    });

    test('does NOT send direct color/brightness command (no flicker)', () => {
        const sl = makeInstance(JSON.parse(JSON.stringify(BASE_CONFIG)));
        sl.currentWindow = 'night';
        sl._switchLastScene = {};
        const sent = [];
        sl._sendCommand = (topic, payload) => sent.push({ topic, payload });

        sl._switchTurnRoomOn('Living Room');

        for (const { payload } of sent) {
            expect(payload).not.toHaveProperty('state', 'ON');
            expect(payload).not.toHaveProperty('brightness');
            expect(payload).not.toHaveProperty('color_temp');
        }
    });

    test('does nothing in Away mode', () => {
        const config = JSON.parse(JSON.stringify(BASE_CONFIG));
        config.house_mode = 'Away';
        const sl = makeInstance(config);
        sl._switchLastScene = {};
        const sent = [];
        sl._sendCommand = (topic, payload) => sent.push({ topic, payload });

        sl._switchTurnRoomOn('Living Room');

        expect(sent).toHaveLength(0);
    });

    test('skips room in Sleep mode when motion_night is off', () => {
        const config = JSON.parse(JSON.stringify(BASE_CONFIG));
        config.house_mode = 'Sleep';
        const sl = makeInstance(config);
        sl._switchLastScene = {};
        const sent = [];
        sl._sendCommand = (topic, payload) => sent.push({ topic, payload });

        // Living Room has motion_night: false
        sl._switchTurnRoomOn('Living Room');
        expect(sent).toHaveLength(0);
    });

    test('activates room in Sleep mode when motion_night is on', () => {
        const config = JSON.parse(JSON.stringify(BASE_CONFIG));
        config.house_mode = 'Sleep';
        const sl = makeInstance(config);
        sl._switchLastScene = {};
        const sent = [];
        sl._sendCommand = (topic, payload) => sent.push({ topic, payload });

        // Bedroom has motion_night: true
        sl._switchTurnRoomOn('Bedroom');
        expect(sent).toHaveLength(1);
        expect(sent[0].payload).toHaveProperty('scene_recall');
    });

    test('tracks last scene in _switchLastScene', () => {
        const sl = makeInstance(JSON.parse(JSON.stringify(BASE_CONFIG)));
        sl.currentWindow = 'day';
        sl._switchLastScene = {};
        sl._sendCommand = jest.fn();

        sl._switchTurnRoomOn('Living Room');

        expect(sl._switchLastScene['Living Room']).toBe('day');
    });
});

// ── Toggle Room regression — the exact "off works, on doesn't" failure ────────
//
// When lights are OFF and the toggle action fires, _executeAction('Toggle Room')
// must call _switchTurnRoomOn, which must send a scene_recall integer (not an
// object). If the format is wrong, Z2M silently ignores the command and the
// light stays off. This is the regression from the first scene_recall attempt.

describe('Toggle Room — power-on path sends a plain-integer scene_recall', () => {
    function makeConfiguredInstance(houseMode = 'Home') {
        const config = JSON.parse(JSON.stringify(BASE_CONFIG));
        config.house_mode = houseMode;
        config.switches = {
            living_room_s_1: {
                room_group: 'Living Room',
                room_key: 'living_room',
                b1_short: 'Default',
                brightness_step_pct: 20,
                min_brightness_pct: 5,
            },
        };
        const sl = makeInstance(config);
        sl._switchLastScene = {};
        return sl;
    }

    test('toggle when room is OFF → scene_recall integer, not object', () => {
        const sl = makeConfiguredInstance();
        sl.currentWindow = 'evening';
        // Room is off
        sl._deviceStateCache['Living Room'] = 'OFF';
        const sent = [];
        sl._sendCommand = (topic, payload) => sent.push({ topic, payload });

        sl._executeAction('Toggle Room', sl.config.switches['living_room_s_1']);

        expect(sent).toHaveLength(1);
        expect(sent[0].topic).toBe('Living Room/set');
        // Must be a plain integer — object form { ID: N } is silently ignored by Z2M
        expect(typeof sent[0].payload.scene_recall).toBe('number');
        expect(sent[0].payload.scene_recall).toBe(3); // evening = 3
    });

    test('toggle when room is ON → state: OFF (no scene_recall)', () => {
        const sl = makeConfiguredInstance();
        sl._deviceStateCache['Living Room'] = 'ON';
        const sent = [];
        sl._sendCommand = (topic, payload) => sent.push({ topic, payload });

        sl._executeAction('Toggle Room', sl.config.switches['living_room_s_1']);

        expect(sent).toHaveLength(1);
        expect(sent[0].payload).toEqual({ state: 'OFF' });
        expect(sent[0].payload).not.toHaveProperty('scene_recall');
    });

    test('toggle off then on (full cycle) → OFF then scene_recall integer', () => {
        const sl = makeConfiguredInstance();
        sl.currentWindow = 'morning';
        sl._deviceStateCache['Living Room'] = 'ON';
        const sent = [];
        sl._sendCommand = (topic, payload) => {
            sent.push({ topic, payload });
            // Simulate state change
            if (payload.state === 'OFF') sl._deviceStateCache['Living Room'] = 'OFF';
            if (typeof payload.scene_recall === 'number') sl._deviceStateCache['Living Room'] = 'ON';
        };
        const switchConfig = sl.config.switches['living_room_s_1'];

        sl._executeAction('Toggle Room', switchConfig); // turn off
        sl._executeAction('Toggle Room', switchConfig); // turn on

        expect(sent[0].payload).toEqual({ state: 'OFF' });
        expect(typeof sent[1].payload.scene_recall).toBe('number');
        expect(sent[1].payload.scene_recall).toBe(1); // morning = 1
    });

    // Real incident, 2026-08-23: kitchen bulbs lost power. The group topic
    // ("Living Room" here) still said ON — Z2M echoes group commands
    // optimistically with no per-bulb ack — while the actual bulb never
    // got the memo and correctly kept reporting OFF. Toggle Room must trust
    // the bulb's real report over the group's assumption, or it sends OFF
    // into a room that was never actually on, and the press does nothing.
    test('group topic optimistically says ON but the real bulb says OFF → toggle still turns it on', () => {
        const sl = makeConfiguredInstance();
        sl.currentWindow = 'night';
        sl._deviceStateCache['Living Room'] = 'ON'; // stale optimistic echo from a prior command
        sl._deviceStateCache['living_room_1'] = 'OFF'; // the bulb's own real report
        const sent = [];
        sl._sendCommand = (topic, payload) => sent.push({ topic, payload });

        sl._executeAction('Toggle Room', sl.config.switches['living_room_s_1']);

        expect(sent).toHaveLength(1);
        expect(typeof sent[0].payload.scene_recall).toBe('number');
        expect(sent[0].payload.scene_recall).toBe(4); // night = 4
    });
});

// ── _cycleScenesForRoom — uses scene_recall ──────────────────────────────────

describe('_cycleScenesForRoom — uses scene_recall, not direct command', () => {
    test('sends scene_recall when cycling from current window', () => {
        const sl = makeInstance(JSON.parse(JSON.stringify(BASE_CONFIG)));
        sl.currentWindow = 'morning';
        sl._switchLastScene = {};
        const sent = [];
        sl._sendCommand = (topic, payload) => sent.push({ topic, payload });

        sl._cycleScenesForRoom('Living Room');

        expect(sent).toHaveLength(1);
        expect(sent[0].payload).toHaveProperty('scene_recall');
        expect(typeof sent[0].payload.scene_recall).toBe('number');
    });

    test('advances through windows in order: morning→day→evening→night→morning', () => {
        const WINDOWS = ['morning', 'day', 'evening', 'night'];
        const WINDOW_SCENE_ID = { morning: 1, day: 2, evening: 3, night: 4 };
        const sl = makeInstance(JSON.parse(JSON.stringify(BASE_CONFIG)));
        sl.currentWindow = 'morning';
        sl._switchLastScene = {};
        const ids = [];
        sl._sendCommand = (_, payload) => {
            if (typeof payload.scene_recall === 'number') ids.push(payload.scene_recall);
        };

        for (let i = 0; i < 5; i++) {
            sl._cycleScenesForRoom('Living Room');
        }

        // From no last scene → starts at currentWindow (morning=1), then cycles
        expect(ids[0]).toBe(WINDOW_SCENE_ID.morning);
        expect(ids[1]).toBe(WINDOW_SCENE_ID.day);
        expect(ids[2]).toBe(WINDOW_SCENE_ID.evening);
        expect(ids[3]).toBe(WINDOW_SCENE_ID.night);
        expect(ids[4]).toBe(WINDOW_SCENE_ID.morning); // wraps
    });

    test('does NOT send direct brightness command (no flicker during cycle)', () => {
        const sl = makeInstance(JSON.parse(JSON.stringify(BASE_CONFIG)));
        sl.currentWindow = 'evening';
        sl._switchLastScene = {};
        const sent = [];
        sl._sendCommand = (_, payload) => sent.push(payload);

        sl._cycleScenesForRoom('Living Room');

        for (const payload of sent) {
            expect(payload).not.toHaveProperty('brightness');
            expect(payload).not.toHaveProperty('state', 'ON');
        }
    });

    test('cycles just the 4 windows when no custom scenes are named', () => {
        const config = JSON.parse(JSON.stringify(BASE_CONFIG));
        const sl = makeInstance(config);
        sl.currentWindow = 'morning';
        sl._switchLastScene = {};
        const ids = [];
        sl._sendCommand = (_, payload) => { if (typeof payload.scene_recall === 'number') ids.push(payload.scene_recall); };

        for (let i = 0; i < 5; i++) sl._cycleScenesForRoom('Living Room');

        expect(ids).toEqual([1, 2, 3, 4, 1]); // morning, day, evening, night, wraps to morning
    });

    test('a named custom scene is automatically appended to the cycle, no toggle required', () => {
        const config = JSON.parse(JSON.stringify(BASE_CONFIG));
        config.rooms['Living Room'].custom_scenes = {
            custom1: { name: 'Movie Night', lights: { living_room_1: { state: 'ON', brightness: 60, color_temp: 454 } } },
        };
        const sl = makeInstance(config);
        sl.currentWindow = 'night';
        sl._switchLastScene = { 'Living Room': 'night' };
        const sent = [];
        sl._sendCommand = (topic, payload) => sent.push({ topic, payload });

        sl._cycleScenesForRoom('Living Room');

        // Custom scenes apply as a direct per-light command, not scene_recall.
        expect(sent).toEqual([{ topic: 'living_room_1/set', payload: { state: 'ON', brightness: 60, color_temp: 454 } }]);
        expect(sl._switchLastScene['Living Room']).toBe('custom1');
    });

    test('an unnamed custom slot never appears in the cycle', () => {
        const config = JSON.parse(JSON.stringify(BASE_CONFIG));
        config.rooms['Living Room'].custom_scenes = {
            custom1: { name: '', lights: { living_room_1: { state: 'ON', brightness: 60 } } }, // never named
        };
        const sl = makeInstance(config);
        sl.currentWindow = 'night';
        sl._switchLastScene = { 'Living Room': 'night' };
        const ids = [];
        sl._sendCommand = (_, payload) => { if (typeof payload.scene_recall === 'number') ids.push(payload.scene_recall); };

        sl._cycleScenesForRoom('Living Room'); // from night, should wrap straight to morning, not custom1

        expect(ids).toEqual([1]);
    });

    test('multiple named custom scenes cycle in slot order, after the 4 windows', () => {
        const config = JSON.parse(JSON.stringify(BASE_CONFIG));
        config.rooms['Living Room'].custom_scenes = {
            custom1: { name: 'Movie Night', lights: { living_room_1: { state: 'ON', brightness: 60 } } },
            custom2: { name: 'Reading', lights: { living_room_1: { state: 'ON', brightness: 180 } } },
        };
        const sl = makeInstance(config);
        sl.currentWindow = 'morning';
        sl._switchLastScene = {};
        sl._sendCommand = () => {};
        const targets = [];

        for (let i = 0; i < 7; i++) {
            sl._cycleScenesForRoom('Living Room');
            targets.push(sl._switchLastScene['Living Room']);
        }

        expect(targets).toEqual(['morning', 'day', 'evening', 'night', 'custom1', 'custom2', 'morning']);
    });

    test('a custom scene with different values per light applies each independently, not one uniform group command', () => {
        const config = JSON.parse(JSON.stringify(BASE_CONFIG));
        config.rooms['Bedroom'].custom_scenes = {
            custom1: {
                name: 'Movie Night',
                lights: {
                    bedroom_1: { state: 'ON', brightness: 38, color: { x: 0.5, y: 0.2 } }, // pink @ 15%
                    lamp_1: { state: 'ON', brightness: 20, color: { x: 0.3, y: 0.1 } }, // purple @ 8%
                    bedroom_2: { state: 'OFF' },
                },
            },
        };
        const sl = makeInstance(config);
        sl._switchLastScene = {};
        const sent = [];
        sl._sendCommand = (topic, payload) => sent.push({ topic, payload });

        sl._recallCustomScene('Bedroom', 'custom1');

        expect(sent).toEqual([
            { topic: 'bedroom_1/set', payload: { state: 'ON', brightness: 38, color: { x: 0.5, y: 0.2 } } },
            { topic: 'lamp_1/set', payload: { state: 'ON', brightness: 20, color: { x: 0.3, y: 0.1 } } },
            { topic: 'bedroom_2/set', payload: { state: 'OFF' } },
        ]);
    });
});

// ── Toggle All Rooms / Scene: Custom N ──────────────────────────────────────

describe('_executeAction — Toggle All Rooms', () => {
    test('turns every room on when all are off', () => {
        const config = JSON.parse(JSON.stringify(BASE_CONFIG));
        const sl = makeInstance(config);
        sl.currentWindow = 'day';
        sl._switchLastScene = {};
        sl._deviceStateCache['Living Room'] = 'OFF';
        sl._deviceStateCache['Bedroom'] = 'OFF';
        const sent = [];
        sl._sendCommand = (topic, payload) => sent.push({ topic, payload });

        sl._executeAction('Toggle All Rooms', { room_group: 'Living Room', room_key: 'living_room' });

        const topics = sent.map(s => s.topic);
        expect(topics).toContain('Living Room/set');
        expect(topics).toContain('Bedroom/set');
        for (const { payload } of sent) {
            expect(typeof payload.scene_recall).toBe('number');
        }
    });

    test('turns every room off when any is on', () => {
        const config = JSON.parse(JSON.stringify(BASE_CONFIG));
        const sl = makeInstance(config);
        sl._deviceStateCache['Living Room'] = 'ON';
        sl._deviceStateCache['Bedroom'] = 'OFF';
        const sent = [];
        sl._sendCommand = (topic, payload) => sent.push({ topic, payload });

        sl._executeAction('Toggle All Rooms', { room_group: 'Living Room', room_key: 'living_room' });

        expect(sent).toEqual([
            { topic: 'Living Room/set', payload: { state: 'OFF' } },
            { topic: 'Bedroom/set', payload: { state: 'OFF' } },
        ]);
    });
});

describe('_onSwitchAction — b4_long default is uniform across every room', () => {
    test('bedroom and non-bedroom switches both default b4_long to Toggle All Rooms — nothing room-specific', () => {
        const config = JSON.parse(JSON.stringify(BASE_CONFIG));
        config.switches = {
            bedroom_s_1: { room_group: 'Bedroom', room_key: 'bedroom', b4_long: 'Default' },
            living_room_s_1: { room_group: 'Living Room', room_key: 'living_room', b4_long: 'Default' },
        };
        const sl = makeInstance(config);
        sl._deviceStateCache['Living Room'] = 'OFF';
        sl._deviceStateCache['Bedroom'] = 'OFF';
        sl._switchLastScene = {};
        const executed = [];
        sl._executeAction = (actionName) => executed.push(actionName);

        sl._onSwitchAction('bedroom_s_1', sl.config.switches.bedroom_s_1, 'off_hold');
        sl._onSwitchAction('living_room_s_1', sl.config.switches.living_room_s_1, 'off_hold');

        expect(executed).toEqual(['Toggle All Rooms', 'Toggle All Rooms']);
    });
});

describe('_executeAction — Scene: Custom N', () => {
    test('recalls the named custom scene as a direct per-light command', () => {
        const config = JSON.parse(JSON.stringify(BASE_CONFIG));
        config.rooms['Living Room'].custom_scenes = {
            custom2: { name: 'Reading', lights: { living_room_1: { state: 'ON', brightness: 180 } } },
        };
        const sl = makeInstance(config);
        sl._switchLastScene = {};
        const sent = [];
        sl._sendCommand = (topic, payload) => sent.push({ topic, payload });

        sl._executeAction('Scene: Custom 2', { room_group: 'Living Room', room_key: 'living_room' });

        expect(sent).toEqual([{ topic: 'living_room_1/set', payload: { state: 'ON', brightness: 180 } }]);
        expect(sl._switchLastScene['Living Room']).toBe('custom2');
    });

    test('does nothing and warns when the targeted slot has no name yet', () => {
        const config = JSON.parse(JSON.stringify(BASE_CONFIG));
        const sl = makeInstance(config);
        const sent = [];
        sl._sendCommand = (topic, payload) => sent.push({ topic, payload });
        const warnings = [];
        sl.logger.warn = (msg) => warnings.push(msg);

        sl._executeAction('Scene: Custom 3', { room_group: 'Living Room', room_key: 'living_room' });

        expect(sent).toHaveLength(0);
        expect(warnings).toHaveLength(1);
    });
});

// ── _recallSceneIfOn — keeps direct command for smooth window transitions ────

describe('_recallSceneIfOn — uses direct command (smooth transition support)', () => {
    test('sends direct brightness+color command (not scene_recall) when auto_transition on', () => {
        const sl = makeInstance(JSON.parse(JSON.stringify(BASE_CONFIG)));
        sl._deviceStateCache = { 'Living Room': 'ON' };
        const sent = [];
        sl._sendCommand = (topic, payload) => sent.push({ topic, payload });

        sl._recallSceneIfOn('Living Room', BASE_CONFIG.rooms['Living Room'], 'evening');

        expect(sent).toHaveLength(1);
        expect(sent[0].payload).toHaveProperty('state', 'ON');
        expect(sent[0].payload).toHaveProperty('brightness');
        expect(sent[0].payload).not.toHaveProperty('scene_recall');
    });

    test('skips when auto_transition is off', () => {
        const sl = makeInstance(JSON.parse(JSON.stringify(BASE_CONFIG)));
        sl._deviceStateCache = { 'Living Room': 'ON' };
        const sent = [];
        sl._sendCommand = (topic, payload) => sent.push({ topic, payload });
        const roomConfig = { ...BASE_CONFIG.rooms['Living Room'], auto_transition: false };

        sl._recallSceneIfOn('Living Room', roomConfig, 'evening');

        expect(sent).toHaveLength(0);
    });

    test('skips when room is off', () => {
        const sl = makeInstance(JSON.parse(JSON.stringify(BASE_CONFIG)));
        sl._deviceStateCache = { 'Living Room': 'OFF' };
        const sent = [];
        sl._sendCommand = (_, payload) => sent.push(payload);

        sl._recallSceneIfOn('Living Room', BASE_CONFIG.rooms['Living Room'], 'morning');

        expect(sent).toHaveLength(0);
    });

    test('end-to-end: a room configured with transition_secs (e.g. the new 3600s default) fades via _transition', () => {
        const sl = makeInstance(JSON.parse(JSON.stringify(BASE_CONFIG)));
        sl._deviceStateCache = { 'Living Room': 'ON' };
        const sent = [];
        sl._sendCommand = (topic, payload) => sent.push({ topic, payload });
        const roomConfig = { ...BASE_CONFIG.rooms['Living Room'], transition_secs: 3600 };

        sl._recallSceneIfOn('Living Room', roomConfig, 'evening');

        expect(sent).toHaveLength(1);
        expect(sent[0].payload).toMatchObject({ state: 'ON', brightness: 150, color_temp: 370, transition: 3600 });
    });
});

// ── _hashConfig ───────────────────────────────────────────────────────────────

describe('_hashConfig', () => {
    const sl = makeInstance();

    test('produces consistent hash for same config', () => {
        const config = { rooms: {}, house_mode: 'Home' };
        expect(sl._hashConfig(config)).toBe(sl._hashConfig(config));
    });

    test('produces different hash for different configs', () => {
        const a = { rooms: { 'Living Room': { brightness: 100 } } };
        const b = { rooms: { 'Living Room': { brightness: 200 } } };
        expect(sl._hashConfig(a)).not.toBe(sl._hashConfig(b));
    });

    test('hash is 12 chars', () => {
        expect(sl._hashConfig({})).toHaveLength(12);
    });
});

// ── _calculateCurrentWindow (with mocked time) ───────────────────────────────

describe('_calculateCurrentWindow', () => {
    const PROFILE = { morning: '07:00', day: '09:00', evening: '18:00', night: '22:00' };
    const CONFIG_WITH_PROFILE = {
        profiles: { weekday: PROFILE },
        day_assignments: {
            monday: 'weekday', tuesday: 'weekday', wednesday: 'weekday',
            thursday: 'weekday', friday: 'weekday', saturday: 'weekday', sunday: 'weekday',
        },
    };

    function slAtHour(h, m = 0) {
        const sl = makeInstance(CONFIG_WITH_PROFILE);
        const d = new Date(2026, 0, 5, h, m); // Monday 2026-01-05
        jest.spyOn(global, 'Date').mockImplementation(() => d);
        const result = sl._calculateCurrentWindow();
        jest.restoreAllMocks();
        return result;
    }

    test('before morning → night (previous day)', () => {
        expect(slAtHour(5, 0)).toBe('night');
    });

    test('at morning boundary', () => {
        expect(slAtHour(7, 0)).toBe('morning');
    });

    test('at day boundary', () => {
        expect(slAtHour(9, 0)).toBe('day');
    });

    test('mid-afternoon → day', () => {
        expect(slAtHour(14, 30)).toBe('day');
    });

    test('at evening boundary', () => {
        expect(slAtHour(18, 0)).toBe('evening');
    });

    test('at night boundary', () => {
        expect(slAtHour(22, 0)).toBe('night');
    });

    test('late night → night', () => {
        expect(slAtHour(23, 59)).toBe('night');
    });
});

// ── Startup scene push — ensures scene_recall turns lights on ─────────────────
//
// scene_recall only turns a light ON if the stored scene includes the OnOff
// attribute (state: 'ON' in the scene_add payload). The config hash reflects HA
// helper values — NOT code content. So after a code change that adds state: 'ON'
// to scene_add, the hash is unchanged and the old skip-if-hash-matches logic
// silently leaves bulbs with stale scenes that cannot turn lights on.
//
// Fix: _handleStartupPush() always calls _fullScenePush regardless of hash so
// every Z2M restart guarantees the bulbs have current scenes.

describe('Startup scene push — scene_recall correctness', () => {
    test('_fullScenePush includes state "ON" in every scene_add so recall turns light on', async () => {
        const sl = makeInstance(JSON.parse(JSON.stringify(BASE_CONFIG)));
        sl.currentWindow = 'evening';
        sl._getEffectiveWindow = () => 'evening';
        sl._savePushedHash = jest.fn();
        sl._publishStatus = jest.fn();

        const commands = [];
        sl._sendCommandsStaggered = jest.fn(async (cmds) => { commands.push(...cmds); });

        await sl._fullScenePush();

        const sceneAdds = commands.filter(c => c.payload && c.payload.scene_add);
        expect(sceneAdds.length).toBeGreaterThan(0);
        for (const { payload } of sceneAdds) {
            expect(payload.scene_add).toHaveProperty('state', 'ON');
        }
    });

    test('_fullScenePush never scene_adds custom scenes — they apply as direct per-light commands instead', async () => {
        // Custom scenes can hold a different value per light, so there's no single
        // group-wide Zigbee scene to pre-store; _applyCustomScene sends direct
        // commands at recall time instead (see the _cycleScenesForRoom /
        // _executeAction — Scene: Custom N tests).
        const config = JSON.parse(JSON.stringify(BASE_CONFIG));
        config.rooms['Living Room'].custom_scenes = {
            custom1: { name: 'Movie Night', lights: { living_room_1: { state: 'ON', brightness: 60, color_temp: 454 } } },
        };
        const sl = makeInstance(config);
        sl.currentWindow = 'evening';
        sl._getEffectiveWindow = () => 'evening';
        sl._savePushedHash = jest.fn();
        sl._publishStatus = jest.fn();

        const commands = [];
        sl._sendCommandsStaggered = jest.fn(async (cmds) => { commands.push(...cmds); });

        await sl._fullScenePush();

        const customAdds = commands.filter(c => c.payload && c.payload.scene_add && c.payload.scene_add.ID >= 5);
        expect(customAdds).toHaveLength(0);
    });

    test('_handleStartupPush always calls _fullScenePush even when config hash matches last push', () => {
        // Without this fix: if pushedHash === configHash, startup skips the push.
        // Bulbs keep stale scenes (no state: 'ON') and scene_recall never turns lights on.
        const sl = makeInstance(JSON.parse(JSON.stringify(BASE_CONFIG)));
        sl.configHash = 'fakehash';
        sl._loadPushedHash = () => 'fakehash'; // hash matches — old code: skip push
        sl._savePushedHash = jest.fn();
        sl._fullScenePush = jest.fn();

        sl._handleStartupPush(); // must exist and must call _fullScenePush unconditionally

        expect(sl._fullScenePush).toHaveBeenCalledTimes(1);
    });

    test('switch press after startup push sends scene_recall that will turn light on', () => {
        // Full chain: startup pushes scene_add (state: 'ON') → bulbs store scene →
        // switch press sends scene_recall integer → bulb turns on at correct scene.
        // If startup push is skipped, bulbs have old scenes and recall silently fails.
        const sl = makeInstance(JSON.parse(JSON.stringify(BASE_CONFIG)));
        sl.currentWindow = 'evening';
        sl._switchLastScene = {};

        const pushCalls = [];
        sl._fullScenePush = jest.fn(() => pushCalls.push(true));

        // Startup push must happen before switch presses are accepted
        sl._handleStartupPush();
        expect(pushCalls).toHaveLength(1);

        // Now switch press must send scene_recall (not direct command — that flickers)
        const sent = [];
        sl._sendCommand = (topic, payload) => sent.push({ topic, payload });
        sl._switchTurnRoomOn('Living Room');

        expect(sent).toHaveLength(1);
        expect(sent[0].topic).toBe('Living Room/set');
        // Plain integer — Z2M recalls the scene (with state: 'ON' stored by startup push)
        expect(typeof sent[0].payload.scene_recall).toBe('number');
        expect(sent[0].payload.scene_recall).toBe(3); // evening = 3
    });

    test('_handleStartupPush does nothing when no config is loaded', () => {
        const sl = makeInstance(null); // no config
        sl._fullScenePush = jest.fn();

        sl._handleStartupPush();

        expect(sl._fullScenePush).not.toHaveBeenCalled();
    });
});

// ── smart_power_on: _onDeviceAnnounce still uses direct command ──────────────

describe('_onDeviceAnnounce — direct command (individual bulb, not group)', () => {
    test('sends direct state+brightness+color_temp to individual bulb', () => {
        const sl = makeInstance(JSON.parse(JSON.stringify(BASE_CONFIG)));
        sl._smartPowerOnReadyAt = 0;
        sl.currentWindow = 'morning';
        const sent = [];
        sl._sendCommand = (topic, payload) => sent.push({ topic, payload });

        // Advance time past ready gate
        jest.useFakeTimers();
        sl._onDeviceAnnounce('living_room_1');
        jest.advanceTimersByTime(500);
        jest.useRealTimers();

        expect(sent).toHaveLength(1);
        expect(sent[0].topic).toBe('living_room_1/set');
        expect(sent[0].payload).toHaveProperty('state', 'ON');
        expect(sent[0].payload).toHaveProperty('brightness');
        // individual bulb announce must NOT use scene_recall (bulb just powered on)
        expect(sent[0].payload).not.toHaveProperty('scene_recall');
    });

    test('ignores announce within smartPowerOnReadyAt window', () => {
        const sl = makeInstance(JSON.parse(JSON.stringify(BASE_CONFIG)));
        sl._smartPowerOnReadyAt = Date.now() + 60000;
        const sent = [];
        sl._sendCommand = (_, payload) => sent.push(payload);

        sl._onDeviceAnnounce('living_room_1');

        expect(sent).toHaveLength(0);
    });
});
