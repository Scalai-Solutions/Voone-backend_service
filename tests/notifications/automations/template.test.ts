import { describe, expect, it } from "vitest";

import { AUTOMATION_CATALOG } from "../../../src/modules/notifications/automations/catalog";
import {
  firstName,
  linkifyForGoogle,
  renderTemplate,
  unknownVariables
} from "../../../src/modules/notifications/template";

describe("renderTemplate", () => {
  it("fills every placeholder", () => {
    expect(
      renderTemplate("Hola {first_name}, bienvenida a {clinic_name}", {
        first_name: "Lucía",
        clinic_name: "Clínica Sol"
      })
    ).toBe("Hola Lucía, bienvenida a Clínica Sol");
  });

  it("never leaves a raw placeholder on a member's phone", () => {
    expect(renderTemplate("Hola {first_name}!", {})).toBe("Hola !");
  });

  it("leaves braces that are not variables alone", () => {
    expect(renderTemplate("{ 10% } {first_name}", { first_name: "Ana" })).toBe("{ 10% } Ana");
  });
});

describe("firstName", () => {
  it("takes the first word of the stored name", () => {
    expect(firstName("María José López")).toBe("María");
    expect(firstName("  Ana ")).toBe("Ana");
    expect(firstName("")).toBe("");
    expect(firstName(null)).toBe("");
  });
});

describe("unknownVariables", () => {
  it("reports names the event does not provide", () => {
    expect(unknownVariables("{first_name} {nope}", ["first_name"])).toEqual(["nope"]);
  });
});

describe("the automation catalog", () => {
  it.each(AUTOMATION_CATALOG.map((definition) => [definition.event, definition] as const))(
    "%s defaults only use its own variables and fit the limits",
    (_event, definition) => {
      expect(unknownVariables(definition.defaults.header, definition.variables)).toEqual([]);
      expect(unknownVariables(definition.defaults.body, definition.variables)).toEqual([]);
      expect(definition.defaults.header.length).toBeLessThanOrEqual(60);
      expect(definition.defaults.body.length).toBeLessThanOrEqual(500);
    }
  );

  it("switches off by default the events that need a clinic value", () => {
    for (const definition of AUTOMATION_CATALOG.filter((entry) => entry.requires)) {
      expect(definition.defaults.enabled).toBe(false);
    }
  });
});

describe("linkifyForGoogle", () => {
  it("wraps a bare URL in an anchor, keeping the sentence's punctuation outside the link", () => {
    expect(linkifyForGoogle("Déjanos tu reseña: https://g.page/r/abc/review.")).toBe(
      'Déjanos tu reseña: <a href="https://g.page/r/abc/review">https://g.page/r/abc/review</a>.'
    );
  });

  it("leaves text that already has an anchor, or no URL, untouched", () => {
    const linked = 'Hola <a href="https://g.page/r/abc">aquí</a>';

    expect(linkifyForGoogle(linked)).toBe(linked);
    expect(linkifyForGoogle("Sin enlaces")).toBe("Sin enlaces");
  });
});
