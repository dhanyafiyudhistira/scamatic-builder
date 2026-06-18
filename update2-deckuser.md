> New: this is new deck-user mode json flow.

## 1. Additional System Overview

This document defines the derived system of new version of deck-user mode based on the json flow of Node-RED.

**update-deckuser.json:**

```

[
    {
        "id": "8f60ab369a41f39a",
        "type": "tab",
        "label": "Sistem1",
        "disabled": false,
        "info": ""
    },
    {
        "id": "42694b3e94e6ae26",
        "type": "s7 in",
        "z": "8f60ab369a41f39a",
        "endpoint": "9c524f8bf408c646",
        "mode": "all",
        "variable": "",
        "diff": false,
        "name": "Read PLC",
        "x": 180,
        "y": 120,
        "wires": [
            [
                "ef6c3dd37575c117"
            ]
        ]
    },
    {
        "id": "ef6c3dd37575c117",
        "type": "function",
        "z": "8f60ab369a41f39a",
        "name": "Format Telemetry",
        "func": "msg.payload = {\n    Valve_106: msg.payload.Valve_106,\n    Valve_205: msg.payload.Valve_205,\n    Valve_201: msg.payload.Valve_201,\n    Valve_304: msg.payload.Valve_304,\n    Pompa_303: msg.payload.Pompa_303,\n    Level_Air: msg.payload.Level_Air,\n    Level_filter: msg.payload.Level_filter,\n};\nreturn msg;",
        "outputs": 1,
        "timeout": "",
        "noerr": 0,
        "initialize": "",
        "finalize": "",
        "libs": [],
        "x": 450,
        "y": 120,
        "wires": [
            [
                "14fcce0c2ad1dd62"
            ]
        ]
    },
    {
        "id": "14fcce0c2ad1dd62",
        "type": "mqtt out",
        "z": "8f60ab369a41f39a",
        "name": "TB Telemetry",
        "topic": "v1/devices/me/telemetry",
        "qos": "1",
        "retain": "",
        "respTopic": "",
        "contentType": "",
        "userProps": "",
        "correl": "",
        "expiry": "",
        "broker": "778e1880cf308ce9",
        "x": 710,
        "y": 120,
        "wires": []
    },
    {
        "id": "b96c65f4b9451985",
        "type": "mqtt in",
        "z": "8f60ab369a41f39a",
        "name": "TB RPC",
        "topic": "v1/devices/me/rpc/request/+",
        "qos": "1",
        "datatype": "auto",
        "broker": "778e1880cf308ce9",
        "nl": false,
        "rap": false,
        "inputs": 0,
        "x": 150,
        "y": 260,
        "wires": [
            [
                "e35fa9e26b85350d"
            ]
        ]
    },
    {
        "id": "e35fa9e26b85350d",
        "type": "json",
        "z": "8f60ab369a41f39a",
        "name": "Parse RPC",
        "property": "payload",
        "action": "",
        "pretty": false,
        "x": 360,
        "y": 260,
        "wires": [
            [
                "629492f2fb4c7a32"
            ]
        ]
    },
    {
        "id": "629492f2fb4c7a32",
        "type": "function",
        "z": "8f60ab369a41f39a",
        "name": "Decode RPC",
        "func": "let method = msg.payload.method;\nlet value = msg.payload.params;\n\nswitch(method){\n\ncase 'setM_ManualV106':\nmsg.topic='M_ManualV106';\nmsg.payload=value;\nreturn msg;\n\ncase 'setM_manualV205':\nmsg.topic='M_manualV205';\nmsg.payload=value;\nreturn msg;\n\n    case 'setM_manualV201':\nmsg.topic='M_manualV201';\nmsg.payload=value;\nreturn msg;\n\ncase 'setM_ManualP303':\nmsg.topic='M_ManualP303';\nmsg.payload=value;\nreturn msg;\n\ncase 'settrigger_Auto':\nmsg.topic='trigger_Auto';\nmsg.payload=value;\nreturn msg;\n\ncase 'settrigger_manual':\nmsg.topic='trigger_manual';\nmsg.payload=value;\nreturn msg;\n\ncase 'setTombol_Reset':\nmsg.topic='Tombol_Reset';\nmsg.payload=value;\nreturn msg;\ndefault:\nreturn null;\n}",
        "outputs": 1,
        "timeout": "",
        "noerr": 0,
        "initialize": "",
        "finalize": "",
        "libs": [],
        "x": 570,
        "y": 260,
        "wires": [
            [
                "82cffd0f5a13ee4b"
            ]
        ]
    },
    {
        "id": "82cffd0f5a13ee4b",
        "type": "s7 out",
        "z": "8f60ab369a41f39a",
        "endpoint": "9c524f8bf408c646",
        "variable": "",
        "name": "Write PLC",
        "x": 800,
        "y": 260,
        "wires": []
    },
    {
        "id": "9c524f8bf408c646",
        "type": "s7 endpoint",
        "transport": "iso-on-tcp",
        "address": "192.168.0.5",
        "port": "102",
        "rack": "0",
        "slot": "1",
        "localtsaphi": "01",
        "localtsaplo": "00",
        "remotetsaphi": "01",
        "remotetsaplo": "00",
        "connmode": "rack-slot",
        "adapter": "",
        "busaddr": "2",
        "cycletime": "1000",
        "timeout": "2000",
        "name": "G2_PLC_1",
        "vartable": [
            {
                "addr": "Q0.2",
                "name": "Valve_106"
            },
            {
                "addr": "Q0.4",
                "name": "Valve_205"
            },
            {
                "addr": "Q0.3",
                "name": "Valve_201"
            },
            {
                "addr": "Q0.5",
                "name": "Valve_304"
            },
            {
                "addr": "Q0.7",
                "name": "Pompa_303"
            },
            {
                "addr": "MW100",
                "name": "Level_Air"
            },
            {
                "addr": "MW104",
                "name": "Level_filter"
            },
            {
                "addr": "M0.1",
                "name": "M_ManualV106"
            },
            {
                "addr": "M0.2",
                "name": "M_manualV205"
            },
            {
                "addr": "M0.3",
                "name": "M_manualV201"
            },
            {
                "addr": "M0.4",
                "name": "M_ManualP303"
            },
            {
                "addr": "M0.5",
                "name": "trigger_Auto"
            },
            {
                "addr": "M0.6",
                "name": "trigger_Manual"
            },
            {
                "addr": "M0.7",
                "name": "Tombol_Reset"
            }
        ]
    },
    {
        "id": "778e1880cf308ce9",
        "type": "mqtt-broker",
        "name": "ThingsBoard",
        "broker": "demo.thingsboard.io",
        "port": "1883",
        "clientid": "",
        "autoConnect": true,
        "usetls": false,
        "protocolVersion": "4",
        "keepalive": "60",
        "cleansession": true,
        "autoUnsubscribe": true,
        "birthTopic": "",
        "birthQos": "0",
        "birthPayload": "",
        "birthMsg": {},
        "closeTopic": "",
        "closePayload": "",
        "closeMsg": {},
        "willTopic": "",
        "willQos": "0",
        "willPayload": "",
        "willMsg": {},
        "userProps": "",
        "sessionExpiry": ""
    },
    {
        "id": "74d0245d5b9ac77d",
        "type": "global-config",
        "env": [],
        "modules": {
            "node-red-contrib-s7": "3.1.1"
        }
    }
]

```