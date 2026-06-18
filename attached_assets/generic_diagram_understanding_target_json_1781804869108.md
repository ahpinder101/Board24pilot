# Generic Diagram Understanding: Target JSON Example

## Purpose

This document shows the target output for a **generic diagram-understanding layer** that can improve an existing RAG system.

The goal is not only to detect that a page contains a diagram. The goal is to attempt to understand what the diagram means: the entities shown, how they relate, what flows through them, what changes state, and whether the system has enough evidence to answer accurately.

This structure is generic. It can support wiring diagrams, hydraulic schematics, pneumatic schematics, process diagrams, exploded parts diagrams, troubleshooting flowcharts, network diagrams and other technical visual formats.

---

## Key idea

Instead of creating a wiring-specific schema like this:

```json
{
  "component_graph": {},
  "wire_path_graph": {},
  "behavior_graph": {}
}
```

Use a generic diagram-understanding structure:

```json
{
  "diagram_understanding": {
    "entities": [],
    "relationships": [],
    "paths": [],
    "behaviors": [],
    "validated_answer_examples": []
  }
}
```

For a wiring diagram, the `paths` might include control paths and power paths.

For a hydraulic schematic, the `paths` might include fluid flow paths.

For an exploded parts diagram, the `paths` might include assembly or removal sequences.

For a troubleshooting flowchart, the `paths` might include decision branches.

---

## Example user question

> “When the START button is pressed, how does power flow through the diagram, and what keeps the motor running after START is released?”

A standard RAG system may retrieve the correct page, but it may not reliably understand the circuit sequence.

The target system should be able to answer:

> Pressing START completes the control circuit from L1 through the normally closed STOP button, through the START button, through the M coil and back to L2. When the M coil energises, it closes both the main contacts and the auxiliary holding contact. The auxiliary holding contact creates a parallel path around START, so the coil remains energised after START is released. The main contacts allow power to flow through overload protection to the motor.

That answer requires the system to understand the diagram relationships, not just retrieve nearby text.

---

## Generic target JSON example

```json
{
  "schema_version": "manual_page.v2",
  "source": "technical_manual.pdf",
  "page": 12,
  "page_type": "mixed_text_and_diagram",
  "page_summary": "This page contains explanatory text and a technical diagram. The diagram has been interpreted as a three-wire motor starter circuit.",
  "page_trust_summary": {
    "page_text": "trusted",
    "diagram_inventory": "trusted",
    "diagram_understanding": "trusted",
    "safe_answering_mode": "detailed"
  },
  "text_blocks": [
    {
      "id": "text_1",
      "type": "paragraph",
      "text": "In three-wire control, pressing the START button energises the starter coil. An auxiliary holding contact then maintains the coil circuit after the START button is released. Pressing STOP breaks the coil circuit.",
      "bbox": [80, 120, 720, 230],
      "key_claims": [
        {
          "id": "claim_start_energises_coil",
          "claim": "Pressing START energises the starter coil.",
          "confidence": 0.96
        },
        {
          "id": "claim_aux_maintains_coil",
          "claim": "The auxiliary holding contact maintains the coil circuit after START is released.",
          "confidence": 0.95
        },
        {
          "id": "claim_stop_breaks_coil",
          "claim": "Pressing STOP breaks the coil circuit.",
          "confidence": 0.95
        }
      ]
    },
    {
      "id": "caption_1",
      "type": "caption",
      "text": "Three-wire control circuit with START, STOP, holding contact and motor starter coil.",
      "linked_region_id": "diagram_1",
      "bbox": [80, 540, 720, 590],
      "key_claims": [
        {
          "id": "claim_three_wire_control",
          "claim": "The diagram is a three-wire motor control circuit.",
          "confidence": 0.97
        },
        {
          "id": "claim_holding_contact_present",
          "claim": "The diagram should include a holding contact.",
          "confidence": 0.96
        }
      ]
    }
  ],
  "regions": [
    {
      "id": "diagram_1",
      "type": "diagram",
      "diagram_type": "electrical_wiring_diagram",
      "bbox": [80, 250, 720, 530],
      "caption_id": "caption_1",
      "extract_as_graph": true,
      "confidence": {
        "region_detection": 0.98,
        "caption_linking": 0.96,
        "diagram_type": 0.95
      }
    }
  ],
  "diagrams": [
    {
      "region_id": "diagram_1",
      "diagram_type": "electrical_wiring_diagram",
      "understanding_goal": "Explain control power flow, motor power flow and holding-contact behaviour.",
      "plain_english_summary": "The diagram shows a three-wire motor starter circuit. Pressing START energises the M coil. The M coil closes the main contacts and the auxiliary holding contact. The holding contact keeps the coil energised after START is released.",
      "diagram_understanding": {
        "entities": [
          {
            "id": "l1_control",
            "label": "L1 control supply",
            "type": "supply_terminal",
            "role": "control_power_source",
            "plain_language": "The live side of the control circuit.",
            "confidence": 0.96
          },
          {
            "id": "stop_button",
            "label": "STOP button",
            "type": "push_button",
            "normal_state": "normally_closed",
            "role": "stop_control",
            "plain_language": "Breaks the control circuit when pressed.",
            "confidence": 0.94
          },
          {
            "id": "start_button",
            "label": "START button",
            "type": "push_button",
            "normal_state": "normally_open",
            "role": "start_control",
            "plain_language": "Momentarily completes the control circuit when pressed.",
            "confidence": 0.94
          },
          {
            "id": "m_coil",
            "label": "M starter coil",
            "type": "contactor_coil",
            "role": "actuator",
            "plain_language": "Closes the main contacts and auxiliary holding contact when energised.",
            "confidence": 0.95
          },
          {
            "id": "m_aux_holding_contact",
            "label": "M auxiliary holding contact",
            "type": "auxiliary_contact",
            "normal_state": "normally_open",
            "role": "seal_in_contact",
            "controlled_by": "m_coil",
            "plain_language": "Maintains the coil circuit after START is released.",
            "confidence": 0.93
          },
          {
            "id": "m_main_contacts",
            "label": "M main power contacts",
            "type": "power_contact",
            "normal_state": "normally_open",
            "role": "motor_power_switching",
            "controlled_by": "m_coil",
            "plain_language": "Close when the M coil energises, allowing power to reach the motor.",
            "confidence": 0.92
          },
          {
            "id": "overload_protection",
            "label": "Overload protection",
            "type": "protection_device",
            "role": "motor_protection",
            "plain_language": "Protects the motor from overload conditions.",
            "confidence": 0.9
          },
          {
            "id": "motor",
            "label": "Motor",
            "type": "load",
            "role": "driven_equipment",
            "plain_language": "The load powered by the circuit.",
            "confidence": 0.95
          },
          {
            "id": "l2_control",
            "label": "L2 control return",
            "type": "return_terminal",
            "role": "control_power_return",
            "plain_language": "The return side of the control circuit.",
            "confidence": 0.96
          }
        ],
        "relationships": [
          {
            "from": "m_coil",
            "to": "m_aux_holding_contact",
            "relationship": "mechanically_closes",
            "plain_language": "When the M coil energises, it closes the auxiliary holding contact.",
            "confidence": 0.92
          },
          {
            "from": "m_coil",
            "to": "m_main_contacts",
            "relationship": "mechanically_closes",
            "plain_language": "When the M coil energises, it closes the main power contacts.",
            "confidence": 0.92
          },
          {
            "from": "overload_protection",
            "to": "motor",
            "relationship": "protects",
            "plain_language": "The overload device protects the motor from excessive current.",
            "confidence": 0.9
          }
        ],
        "paths": [
          {
            "id": "start_press_path",
            "path_type": "electrical_control_flow",
            "condition": "START is pressed and STOP is closed",
            "sequence": ["l1_control", "stop_button", "start_button", "m_coil", "l2_control"],
            "plain_language": "Control power flows from L1 through the normally closed STOP button, through the pressed START button, through the M coil and back to L2.",
            "result": "M coil energises",
            "confidence": 0.91
          },
          {
            "id": "holding_path",
            "path_type": "electrical_control_flow",
            "condition": "M coil is energised and START is released",
            "sequence": ["l1_control", "stop_button", "m_aux_holding_contact", "m_coil", "l2_control"],
            "plain_language": "The auxiliary holding contact creates a parallel path around START, keeping the coil energised after START is released.",
            "result": "Motor continues running",
            "confidence": 0.9
          },
          {
            "id": "motor_power_path",
            "path_type": "electrical_power_flow",
            "condition": "M main contacts are closed",
            "sequence": ["three_phase_supply", "m_main_contacts", "overload_protection", "motor"],
            "plain_language": "Power flows through the main contacts and overload protection to the motor.",
            "result": "Motor is energised",
            "confidence": 0.89
          }
        ],
        "behaviors": [
          {
            "event": "START button is pressed",
            "causes": ["control circuit closes", "M coil energises"],
            "confidence": 0.91
          },
          {
            "event": "M coil energises",
            "causes": ["main contacts close", "auxiliary holding contact closes"],
            "confidence": 0.92
          },
          {
            "event": "START button is released",
            "condition": "auxiliary holding contact is closed",
            "causes": ["M coil remains energised through holding path", "motor continues running"],
            "confidence": 0.9
          },
          {
            "event": "STOP button is pressed",
            "causes": ["control circuit opens", "M coil de-energises", "main contacts open", "motor stops"],
            "confidence": 0.91
          }
        ]
      },
      "validated_answer_examples": [
        {
          "question": "When START is pressed, how does power flow?",
          "answer": "Control power flows from L1 through the normally closed STOP button, through the pressed START button, through the M coil and back to L2. This energises the M coil.",
          "supporting_paths": ["start_press_path"],
          "supporting_entities": ["stop_button", "start_button", "m_coil"],
          "confidence": 0.91
        },
        {
          "question": "What keeps the motor running after START is released?",
          "answer": "The M auxiliary holding contact closes when the M coil energises, creating a parallel path around START so the coil remains energised after START is released.",
          "supporting_paths": ["holding_path"],
          "supporting_entities": ["m_aux_holding_contact", "m_coil"],
          "confidence": 0.9
        },
        {
          "question": "How does power reach the motor?",
          "answer": "When the M coil energises, the M main contacts close. Power then flows through the main contacts and overload protection to the motor.",
          "supporting_paths": ["motor_power_path"],
          "supporting_entities": ["m_main_contacts", "overload_protection", "motor"],
          "confidence": 0.89
        }
      ],
      "validation_report": {
        "passed": true,
        "checks": [
          {
            "expectation": "Diagram should include START, STOP, coil and holding contact",
            "passed": true
          },
          {
            "expectation": "Control path and power path should be separated",
            "passed": true
          },
          {
            "expectation": "Holding path should bypass START after coil energises",
            "passed": true
          },
          {
            "expectation": "Behaviour graph should agree with extracted paths",
            "passed": true
          }
        ]
      },
      "evidence": {
        "source_region_id": "diagram_1",
        "caption_id": "caption_1",
        "supporting_text_block_ids": ["text_1"],
        "debug_crop_path": "debug/page_12/diagram_1.png",
        "evidence_policy": "Detailed answers require a supporting text claim, diagram path or validated graph relationship."
      },
      "confidence": {
        "entity_detection": 0.93,
        "relationship_extraction": 0.91,
        "path_extraction": 0.9,
        "behavior_understanding": 0.9,
        "caption_alignment": 0.96,
        "overall_answerability": 0.92
      },
      "trust_status": "trusted",
      "safe_answering_mode": "detailed"
    }
  ]
}
```

---

## How the same schema works for other diagram types

### Hydraulic schematic

```json
{
  "diagram_type": "hydraulic_schematic",
  "diagram_understanding": {
    "entities": [
      {
        "id": "pump_p1",
        "label": "Pump P1",
        "type": "pump",
        "role": "fluid_source"
      },
      {
        "id": "relief_valve_v1",
        "label": "Relief valve V1",
        "type": "relief_valve",
        "role": "pressure_protection"
      },
      {
        "id": "actuator_a1",
        "label": "Actuator A1",
        "type": "actuator",
        "role": "motion_output"
      }
    ],
    "paths": [
      {
        "id": "fluid_flow_path_1",
        "path_type": "fluid_flow",
        "condition": "Directional valve is open",
        "sequence": ["pump_p1", "directional_valve", "actuator_a1", "return_line"],
        "plain_language": "Fluid flows from the pump through the directional valve to the actuator, then returns to the tank.",
        "result": "Actuator extends"
      }
    ],
    "behaviors": [
      {
        "event": "Pressure exceeds relief setting",
        "causes": ["relief valve opens", "fluid returns to tank", "system pressure is limited"]
      }
    ]
  }
}
```

### Exploded parts diagram

```json
{
  "diagram_type": "exploded_parts_diagram",
  "diagram_understanding": {
    "entities": [
      {
        "id": "cover",
        "label": "Cover",
        "type": "part",
        "role": "housing_component"
      },
      {
        "id": "gasket",
        "label": "Gasket",
        "type": "part",
        "role": "seal"
      },
      {
        "id": "screw_1",
        "label": "Screw",
        "type": "fastener",
        "role": "retains_cover"
      }
    ],
    "relationships": [
      {
        "from": "screw_1",
        "to": "cover",
        "relationship": "fastens"
      },
      {
        "from": "gasket",
        "to": "cover",
        "relationship": "seals_between"
      }
    ],
    "paths": [
      {
        "id": "removal_sequence_1",
        "path_type": "removal_sequence",
        "sequence": ["screw_1", "cover", "gasket"],
        "plain_language": "Remove the screws first, then lift the cover and remove the gasket."
      }
    ]
  }
}
```

### Troubleshooting flowchart

```json
{
  "diagram_type": "troubleshooting_flowchart",
  "diagram_understanding": {
    "entities": [
      {
        "id": "symptom_no_start",
        "label": "Motor does not start",
        "type": "symptom"
      },
      {
        "id": "check_voltage",
        "label": "Check supply voltage",
        "type": "decision"
      },
      {
        "id": "replace_fuse",
        "label": "Replace fuse",
        "type": "action"
      }
    ],
    "paths": [
      {
        "id": "no_start_no_voltage_path",
        "path_type": "decision_flow",
        "condition": "No voltage present",
        "sequence": ["symptom_no_start", "check_voltage", "replace_fuse"],
        "plain_language": "If the motor does not start and no voltage is present, check and replace the fuse."
      }
    ]
  }
}
```

---

## Retrieval and answering flow

### 1. User asks a question

Example:

> “When the START button is pressed, how does power flow and why does the motor continue running?”

### 2. The RAG system retrieves the relevant page

The existing RAG layer retrieves the page text and caption.

### 3. The diagram-understanding layer retrieves structured evidence

It retrieves:

- the diagram region;
- the linked caption;
- relevant entities;
- relevant relationships;
- relevant paths;
- relevant behavior events;
- validation checks;
- confidence scores;
- source crop path.

### 4. The answer uses validated relationships

The assistant can answer from graph evidence:

> Pressing START completes the control circuit from L1 through the normally closed STOP button, through the pressed START button, through the M coil and back to L2. This energises the M coil. The M coil closes the main power contacts and the auxiliary holding contact. The holding contact creates a parallel path around START, so the coil remains energised after START is released and the motor keeps running.

### 5. Confidence controls the response

If the diagram is trusted, the assistant can answer in detail.

If the diagram is partial, the assistant should answer cautiously.

If the diagram failed, the assistant should not make technical claims from it.

---

## Why this proves understanding

This target output shows that the system is not only seeing the diagram or reading text around it.

It is attempting to understand:

- what the diagram type is;
- what entities appear in it;
- how entities relate;
- what flows through the diagram;
- what causes state changes;
- what evidence supports each claim;
- whether the answer is safe to provide.

The core value is that retrieval becomes evidence-driven rather than text-only.

The system is no longer just asking:

> “Which text chunk is similar to the user’s question?”

It is also asking:

> “Which diagram, entities, paths, relationships and validation checks support this answer, and is the confidence high enough to answer safely?”