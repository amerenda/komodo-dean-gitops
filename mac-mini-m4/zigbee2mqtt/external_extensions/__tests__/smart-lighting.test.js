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

// ── _buildDirectScenePayload ─────────────────────────────────────────────────

describe('_buildDirectScenePayload', () => {
    test('returns color_temp payload for CT scene', () => {
        const sl = makeInstance();
        const payload = sl._buildDirectScenePayload('evening', BASE_CONFIG.rooms['Living Room']);
        expect(payload).toMatchObject({ state: 'ON', brightness: 150, color_temp: 370 });
        expect(payload.color).toBeUndefined();
    });

    test('returns xy color payload for XY scene', () => {
        const sl = makeInstance();
        const payload = sl._buildDirectScenePayload('evening', BASE_CONFIG.rooms['Bedroom']);
        expect(payload).toMatchObject({ state: 'ON', brightness: 100, color: { x: 0.37, y: 0.20 } });
        expect(payload.color_temp).toBeUndefined();
    });

    test('returns brightness-only payload when no color info', () => {
        const sl = makeInstance();
        const roomConfig = {
            scenes: { morning: { brightness: 100 } },
            transition_secs: 0,
        };
        const payload = sl._buildDirectScenePayload('morning', roomConfig);
        expect(payload).toMatchObject({ state: 'ON', brightness: 100 });
        expect(payload.color).toBeUndefined();
        expect(payload.color_temp).toBeUndefined();
    });

    test('returns null for missing window', () => {
        const sl = makeInstance();
        const payload = sl._buildDirectScenePayload('evening', { scenes: {} });
        expect(payload).toBeNull();
    });

    test('includes transition when transition_secs > 0', () => {
        const sl = makeInstance();
        const roomConfig = {
            scenes: { morning: { brightness: 200, color_temp: 250 } },
            transition_secs: 30,
        };
        const payload = sl._buildDirectScenePayload('morning', roomConfig);
        expect(payload.transition).toBe(30);
    });

    test('omits transition when transition_secs is 0', () => {
        const sl = makeInstance();
        const payload = sl._buildDirectScenePayload('morning', BASE_CONFIG.rooms['Living Room']);
        expect(payload.transition).toBeUndefined();
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
