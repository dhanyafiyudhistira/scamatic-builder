> New: this is new deck-user mode json flow.

## 1. Additional System Overview

This document defines the derived system of new version of deck-user mode based on the json flow of Node-RED.

**update-deckuser.json:**

```

[
    {
        "id": "7a0e0b1c4fee8366",
        "type": "tab",
        "label": "Sistem2",
        "disabled": false,
        "info": "",
        "env": []
    },
    {
        "id": "25540ab81a0942dc",
        "type": "s7 in",
        "z": "7a0e0b1c4fee8366",
        "endpoint": "6b81a17e6ca3c10f",
        "mode": "all",
        "variable": "",
        "diff": false,
        "name": "Read PLC",
        "x": 300,
        "y": 100,
        "wires": [
            [
                "f6fd9c44f80fb843"
            ]
        ]
    },
    {
        "id": "f6fd9c44f80fb843",
        "type": "function",
        "z": "7a0e0b1c4fee8366",
        "name": "Format Telemetry",
        "func": "msg.payload = {\n    Valve_104: msg.payload.Valve_104,\n    Valve_105: msg.payload.Valve_105,\n    Valve_106: msg.payload.Valve_106,\n    Motor_101: msg.payload.Motor_101,\n    Simulasi_OpeningV104: msg.payload. Simulasi_OpeningV104,\n    Level_mix: msg.payload.Level_mix,\n    QI_102: msg.payload.QI_102,\n};\nreturn msg;",
        "outputs": 1,
        "timeout": "",
        "noerr": 0,
        "initialize": "",
        "finalize": "",
        "libs": [],
        "x": 570,
        "y": 100,
        "wires": [
            [
                "e61774670835d0c4"
            ]
        ]
    },
    {
        "id": "e61774670835d0c4",
        "type": "mqtt out",
        "z": "7a0e0b1c4fee8366",
        "name": "TB Telemetry",
        "topic": "v1/devices/me/telemetry",
        "qos": "1",
        "retain": "",
        "respTopic": "",
        "contentType": "",
        "userProps": "",
        "correl": "",
        "expiry": "",
        "broker": "d61664903af23109",
        "x": 830,
        "y": 100,
        "wires": []
    },
    {
        "id": "390dce8f81e80310",
        "type": "mqtt in",
        "z": "7a0e0b1c4fee8366",
        "name": "TB RPC",
        "topic": "v1/devices/me/rpc/request/+",
        "qos": "1",
        "datatype": "auto",
        "broker": "d61664903af23109",
        "nl": false,
        "rap": false,
        "inputs": 0,
        "x": 260,
        "y": 260,
        "wires": [
            [
                "9a59222c2a279631"
            ]
        ]
    },
    {
        "id": "9a59222c2a279631",
        "type": "json",
        "z": "7a0e0b1c4fee8366",
        "name": "Parse RPC",
        "property": "payload",
        "action": "",
        "pretty": false,
        "x": 470,
        "y": 260,
        "wires": [
            [
                "f0493b85a9d006bf",
                "bfe1581fed7fcad9",
                "6e845fd3f8dd44f8",
                "3824fc008055d095",
                "c880035d41c6032d",
                "33810139724b8355",
                "0dd6bdb9868b8540"
            ]
        ]
    },
    {
        "id": "f0493b85a9d006bf",
        "type": "function",
        "z": "7a0e0b1c4fee8366",
        "name": "Decode RPCTriggerA",
        "func": "let method = msg.payload.method;\nlet value = (msg.payload.params == true || msg.payload.params == \"true\" || msg.payload.params == 1);\n\nswitch(method){\n\ncase 'setTrigger_Auto':\nmsg.topic='Trigger_Auto';\nmsg.payload= value;\nreturn msg;\n\ndefault:\nreturn null;\n}",
        "outputs": 1,
        "timeout": "",
        "noerr": 0,
        "initialize": "",
        "finalize": "",
        "libs": [],
        "x": 710,
        "y": 260,
        "wires": [
            [
                "1863f38ef0489015"
            ]
        ]
    },
    {
        "id": "1863f38ef0489015",
        "type": "s7 out",
        "z": "7a0e0b1c4fee8366",
        "endpoint": "6b81a17e6ca3c10f",
        "variable": "Trigger_Auto",
        "name": "Write PLC",
        "x": 910,
        "y": 260,
        "wires": []
    },
    {
        "id": "bfe1581fed7fcad9",
        "type": "function",
        "z": "7a0e0b1c4fee8366",
        "name": "Decode RPCTriggerM",
        "func": "let method = msg.payload.method;\nlet value = (msg.payload.params == true || msg.payload.params == \"true\" || msg.payload.params == 1);\n\nswitch(method){\n\ncase 'setTrigger_Manual':\nmsg.topic='Trigger_Manual';\nmsg.payload= value;\nreturn msg;\n\ndefault:\nreturn null;\n}",
        "outputs": 1,
        "timeout": "",
        "noerr": 0,
        "initialize": "",
        "finalize": "",
        "libs": [],
        "x": 700,
        "y": 320,
        "wires": [
            [
                "482eed07f5239989"
            ]
        ]
    },
    {
        "id": "6e845fd3f8dd44f8",
        "type": "function",
        "z": "7a0e0b1c4fee8366",
        "name": "Decode RPCV104",
        "func": "let method = msg.payload.method;\nlet value = (msg.payload.params == true || msg.payload.params == \"true\" || msg.payload.params == 1);\n\nswitch(method){\n\ncase 'setManual_V104':\nmsg.topic='Manual_V104';\nmsg.payload= value;\nreturn msg;\n\ndefault:\nreturn null;\n}",
        "outputs": 1,
        "timeout": "",
        "noerr": 0,
        "initialize": "",
        "finalize": "",
        "libs": [],
        "x": 690,
        "y": 440,
        "wires": [
            [
                "3cb048b9cef9b864"
            ]
        ]
    },
    {
        "id": "3824fc008055d095",
        "type": "function",
        "z": "7a0e0b1c4fee8366",
        "name": "Decode RPCV105",
        "func": "let method = msg.payload.method;\nlet value = (msg.payload.params == true || msg.payload.params == \"true\" || msg.payload.params == 1);\n\nswitch(method){\n\n\ncase 'setManual_V105':\nmsg.topic='Manual_V105';\nmsg.payload= value;\nreturn msg;\n\ndefault:\nreturn null;\n}",
        "outputs": 1,
        "timeout": "",
        "noerr": 0,
        "initialize": "",
        "finalize": "",
        "libs": [],
        "x": 690,
        "y": 500,
        "wires": [
            [
                "e7a6e11bf6b47ab4"
            ]
        ]
    },
    {
        "id": "c880035d41c6032d",
        "type": "function",
        "z": "7a0e0b1c4fee8366",
        "name": "Decode RPCV106",
        "func": "let method = msg.payload.method;\nlet value = (msg.payload.params == true || msg.payload.params == \"true\" || msg.payload.params == 1);\n\nswitch(method){\n\ncase 'setManual_V106':\nmsg.topic='Manual_V106';\nmsg.payload= value;\nreturn msg;\n\ndefault:\nreturn null;\n}",
        "outputs": 1,
        "timeout": "",
        "noerr": 0,
        "initialize": "",
        "finalize": "",
        "libs": [],
        "x": 690,
        "y": 560,
        "wires": [
            [
                "d0ea09090cfa578f"
            ]
        ]
    },
    {
        "id": "33810139724b8355",
        "type": "function",
        "z": "7a0e0b1c4fee8366",
        "name": "Decode RPCM101",
        "func": "let method = msg.payload.method;\nlet value = (msg.payload.params == true || msg.payload.params == \"true\" || msg.payload.params == 1);\n\nswitch(method){\n\ncase 'setManual_M101':\nmsg.topic='Manual_M101';\nmsg.payload= value;\nreturn msg;\n\ndefault:\nreturn null;\n}",
        "outputs": 1,
        "timeout": "",
        "noerr": 0,
        "initialize": "",
        "finalize": "",
        "libs": [],
        "x": 690,
        "y": 660,
        "wires": [
            [
                "d1dd02a4cf403332"
            ]
        ]
    },
    {
        "id": "482eed07f5239989",
        "type": "s7 out",
        "z": "7a0e0b1c4fee8366",
        "endpoint": "6b81a17e6ca3c10f",
        "variable": "Trigger_Manual",
        "name": "Write PLC",
        "x": 910,
        "y": 320,
        "wires": []
    },
    {
        "id": "3cb048b9cef9b864",
        "type": "s7 out",
        "z": "7a0e0b1c4fee8366",
        "endpoint": "6b81a17e6ca3c10f",
        "variable": "Manual_V104",
        "name": "Write PLC",
        "x": 910,
        "y": 420,
        "wires": []
    },
    {
        "id": "e7a6e11bf6b47ab4",
        "type": "s7 out",
        "z": "7a0e0b1c4fee8366",
        "endpoint": "6b81a17e6ca3c10f",
        "variable": "Manual_V105",
        "name": "Write PLC",
        "x": 910,
        "y": 480,
        "wires": []
    },
    {
        "id": "d0ea09090cfa578f",
        "type": "s7 out",
        "z": "7a0e0b1c4fee8366",
        "endpoint": "6b81a17e6ca3c10f",
        "variable": "Manual_V106",
        "name": "Write PLC",
        "x": 910,
        "y": 540,
        "wires": []
    },
    {
        "id": "d1dd02a4cf403332",
        "type": "s7 out",
        "z": "7a0e0b1c4fee8366",
        "endpoint": "6b81a17e6ca3c10f",
        "variable": "Manual_M101",
        "name": "Write PLC",
        "x": 910,
        "y": 640,
        "wires": []
    },
    {
        "id": "0dd6bdb9868b8540",
        "type": "function",
        "z": "7a0e0b1c4fee8366",
        "name": "Decode RPCReset",
        "func": "let method = msg.payload.method;\nlet value = (msg.payload.params == true || msg.payload.params == \"true\" || msg.payload.params == 1);\n\nswitch(method){\n\ncase 'setReset':\nmsg.topic='Reset';\nmsg.payload= value;\nreturn msg;\n\ndefault:\nreturn null;\n}",
        "outputs": 1,
        "timeout": "",
        "noerr": 0,
        "initialize": "",
        "finalize": "",
        "libs": [],
        "x": 690,
        "y": 380,
        "wires": [
            [
                "02041aea75844309"
            ]
        ]
    },
    {
        "id": "02041aea75844309",
        "type": "s7 out",
        "z": "7a0e0b1c4fee8366",
        "endpoint": "6b81a17e6ca3c10f",
        "variable": "Reset",
        "name": "Write PLC",
        "x": 910,
        "y": 380,
        "wires": []
    },
    {
        "id": "69b949953b46df70",
        "type": "function",
        "z": "7a0e0b1c4fee8366",
        "name": "Decode RPCLevel_mix",
        "func": "// Memastikan perintah RPC yang masuk adalah method yang benar dari slider\nif (msg.payload.method === \"setLevel_mix\" || msg.payload.method === \"setValue\") {\n    \n    // Ambil nilai angkanya\n    msg.payload = msg.payload.params;\n    \n    // Arahkan ke tag PLC S7\n    msg.topic = \"Level_mix\";\n    \n    return msg;\n}",
        "outputs": 1,
        "timeout": "",
        "noerr": 0,
        "initialize": "",
        "finalize": "",
        "libs": [],
        "x": 690,
        "y": 760,
        "wires": [
            [
                "197269fe063d2397"
            ]
        ]
    },
    {
        "id": "a3cc991f2a46c146",
        "type": "function",
        "z": "7a0e0b1c4fee8366",
        "name": "Decode RPCM101",
        "func": "// Memastikan perintah RPC yang masuk adalah method yang benar dari slider\nif (msg.payload.method === \"setQI_102\" || msg.payload.method === \"setValue\") {\n    \n    // Ambil nilai angkanya\n    msg.payload = msg.payload.params;\n    \n    // Arahkan ke tag PLC S7\n    msg.topic = \"QI_102\";\n    \n    return msg;\n}",
        "outputs": 1,
        "timeout": "",
        "noerr": 0,
        "initialize": "",
        "finalize": "",
        "libs": [],
        "x": 670,
        "y": 820,
        "wires": [
            [
                "45819b65fd28de90"
            ]
        ]
    },
    {
        "id": "197269fe063d2397",
        "type": "s7 out",
        "z": "7a0e0b1c4fee8366",
        "endpoint": "6b81a17e6ca3c10f",
        "variable": "Level_mix",
        "name": "Write PLC",
        "x": 910,
        "y": 760,
        "wires": []
    },
    {
        "id": "45819b65fd28de90",
        "type": "s7 out",
        "z": "7a0e0b1c4fee8366",
        "endpoint": "6b81a17e6ca3c10f",
        "variable": "QI_102",
        "name": "Write PLC",
        "x": 910,
        "y": 820,
        "wires": []
    },
    {
        "id": "f1e4329db6985b95",
        "type": "mqtt in",
        "z": "7a0e0b1c4fee8366",
        "name": "value",
        "topic": "v1/devices/me/rpc/request/+",
        "qos": "1",
        "datatype": "json",
        "broker": "d61664903af23109",
        "nl": false,
        "rap": false,
        "inputs": 0,
        "x": 350,
        "y": 780,
        "wires": [
            [
                "69b949953b46df70",
                "a3cc991f2a46c146"
            ]
        ]
    },
    {
        "id": "6b81a17e6ca3c10f",
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
        "busaddr": 2,
        "cycletime": 1000,
        "timeout": 2000,
        "name": "G2_PLC_Dhany",
        "vartable": [
            {
                "addr": "Q0.0",
                "name": "Valve_104"
            },
            {
                "addr": "Q0.1",
                "name": "Valve_105"
            },
            {
                "addr": "Q0.2",
                "name": "Valve_106"
            },
            {
                "addr": "Q0.6",
                "name": "Motor_101"
            },
            {
                "addr": "MW200",
                "name": "Simulasi_OpeningV104"
            },
            {
                "addr": "MW101",
                "name": "Level_mix"
            },
            {
                "addr": "M11.1",
                "name": "Trigger_Auto"
            },
            {
                "addr": "M11.2",
                "name": "Trigger_Manual"
            },
            {
                "addr": "M11.3",
                "name": "Reset"
            },
            {
                "addr": "M10.5",
                "name": "Manual_V104"
            },
            {
                "addr": "M10.6",
                "name": "Manual_V105"
            },
            {
                "addr": "M10.7",
                "name": "Manual_V106"
            },
            {
                "addr": "M11.0",
                "name": "Manual_M101"
            },
            {
                "addr": "MW300",
                "name": "QI_102"
            }
        ]
    },
    {
        "id": "d61664903af23109",
        "type": "mqtt-broker",
        "name": "TBMixing",
        "broker": "demo.thingsboard.io",
        "port": 1883,
        "clientid": "",
        "autoConnect": true,
        "usetls": false,
        "protocolVersion": 4,
        "keepalive": 60,
        "cleansession": true,
        "autoUnsubscribe": true,
        "birthTopic": "",
        "birthQos": "0",
        "birthRetain": "false",
        "birthPayload": "",
        "birthMsg": {},
        "closeTopic": "",
        "closeQos": "0",
        "closeRetain": "false",
        "closePayload": "",
        "closeMsg": {},
        "willTopic": "",
        "willQos": "0",
        "willRetain": "false",
        "willPayload": "",
        "willMsg": {},
        "userProps": "",
        "sessionExpiry": ""
    },
    {
        "id": "fd7f49b3f1874221",
        "type": "global-config",
        "env": [],
        "modules": {
            "node-red-contrib-s7": "3.1.1"
        }
    }
]

```