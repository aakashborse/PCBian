// Starter projects shown on the dashboard.
import * as Y from "yjs";
import { addComponent, attachNet, autoPlace, connect, getDesign, initDoc, setBoard, updateComponent } from "@pcbian/core";

export const TEMPLATES = [
  { id: "blank", name: "Blank project", description: "Empty schematic and a 50x40mm two-layer board." },
  { id: "blinker555", name: "555 LED blinker", description: "Classic NE555 astable oscillator driving an LED, powered from a 2-pin header." },
  { id: "usb_ldo", name: "USB-C 3.3V supply", description: "USB-C power input with CC pulldowns, AMS1117-3.3 LDO and a power LED." },
] as const;

export type TemplateId = (typeof TEMPLATES)[number]["id"];

export function buildTemplate(doc: Y.Doc, template: TemplateId, name: string) {
  initDoc(doc, name);
  doc.transact(() => {
    if (template === "blinker555") blinker(doc);
    if (template === "usb_ldo") usbLdo(doc);
  });
  if (template !== "blank") {
    const { placements } = autoPlace(getDesign(doc));
    doc.transact(() => {
      for (const [id, pcb] of placements) updateComponent(doc, id, { pcb });
    });
  }
}

function blinker(doc: Y.Doc) {
  setBoard(doc, { width: 40, height: 30 });
  addComponent(doc, "ne555_dip8", { x: 200, y: 100 }, { ref: "U1" });
  addComponent(doc, "resistor_0603", { x: 40, y: 20 }, { ref: "R1", value: "1k", rot: 90 });
  addComponent(doc, "resistor_0603", { x: 40, y: 110 }, { ref: "R2", value: "47k", rot: 90 });
  addComponent(doc, "capacitor_0805", { x: 40, y: 200 }, { ref: "C1", value: "10uF", rot: 90 });
  addComponent(doc, "capacitor_0603", { x: 120, y: 200 }, { ref: "C2", value: "10nF", rot: 90 });
  addComponent(doc, "capacitor_0603", { x: 320, y: 20 }, { ref: "C3", value: "100nF", rot: 90 });
  addComponent(doc, "resistor_0603", { x: 380, y: 90 }, { ref: "R3", value: "330" });
  addComponent(doc, "led_0603", { x: 470, y: 90 }, { ref: "D1", value: "Red" });
  addComponent(doc, "header_1x2", { x: -120, y: 100 }, { ref: "J1", value: "PWR" });

  for (const [a, b] of [
    ["R1.2", "U1.DISCH"],
    ["R2.1", "U1.DISCH"],
    ["R2.2", "U1.THR"],
    ["U1.THR", "U1.TRIG"],
    ["C1.1", "U1.TRIG"],
    ["C2.1", "U1.CV"],
    ["U1.OUT", "R3.1"],
    ["R3.2", "D1.A"],
    ["U1.RESET", "U1.VCC"],
  ]) connect(doc, a, b);
  for (const p of ["R1.1", "U1.VCC", "C3.1", "J1.1"]) attachNet(doc, p, "+5V");
  for (const p of ["C1.2", "C2.2", "C3.2", "U1.GND", "D1.K", "J1.2"]) attachNet(doc, p, "GND");
}

function usbLdo(doc: Y.Doc) {
  setBoard(doc, { width: 35, height: 25 });
  addComponent(doc, "usb_c_power", { x: 0, y: 100 }, { ref: "J1" });
  addComponent(doc, "resistor_0603", { x: 120, y: 200 }, { ref: "R1", value: "5.1k", rot: 90 });
  addComponent(doc, "resistor_0603", { x: 180, y: 200 }, { ref: "R2", value: "5.1k", rot: 90 });
  addComponent(doc, "fuse_1206", { x: 160, y: 40 }, { ref: "F1", value: "500mA" });
  addComponent(doc, "capacitor_0805", { x: 250, y: 120 }, { ref: "C1", value: "10uF", rot: 90 });
  addComponent(doc, "ams1117_33", { x: 360, y: 60 }, { ref: "U1" });
  addComponent(doc, "capacitor_0805", { x: 480, y: 120 }, { ref: "C2", value: "10uF", rot: 90 });
  addComponent(doc, "resistor_0603", { x: 560, y: 40 }, { ref: "R3", value: "1k" });
  addComponent(doc, "led_0603", { x: 560, y: 130 }, { ref: "D1", value: "Green", rot: 90 });

  connect(doc, "J1.VBUS", "F1.1");
  connect(doc, "J1.CC1", "R1.1");
  connect(doc, "J1.CC2", "R2.1");
  connect(doc, "U1.VOUT", "U1.TAB");
  connect(doc, "R3.2", "D1.A");
  for (const p of ["F1.2", "C1.1", "U1.VIN"]) attachNet(doc, p, "VBUS");
  for (const p of ["U1.VOUT", "C2.1", "R3.1"]) attachNet(doc, p, "+3V3");
  for (const p of ["J1.GND", "J1.SHIELD", "R1.2", "R2.2", "C1.2", "C2.2", "U1.GND", "D1.K"]) attachNet(doc, p, "GND");
}
