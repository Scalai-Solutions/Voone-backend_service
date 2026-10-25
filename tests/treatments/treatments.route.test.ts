import express from "express";
import { describe, expect, it } from "vitest";

import { errorHandler } from "../../src/common/middleware/error-handler";
import { ClinicNotFoundError } from "../../src/common/errors/membership.errors";
import {
  TreatmentNotFoundError,
  TreatmentValidationError
} from "../../src/common/errors/treatment.errors";
import type { TreatmentRow } from "../../src/modules/treatments/treatment-catalogue.service";
import { createTreatmentsRouter } from "../../src/routes/v1/treatments.route";

const row: TreatmentRow = {
  id: "t-1",
  name: "Limpieza",
  priceEuro: 45,
  points: 450,
  categoryId: "FAC"
};

const buildApp = () => {
  const calls: unknown[] = [];
  const app = express();

  app.use(express.json());
  app.use(
    "/api/v1",
    createTreatmentsRouter({
      findClinic: async (slug) => {
        if (slug !== "aurea") throw new ClinicNotFoundError(slug);

        return { id: "clinic-1" };
      },
      catalogue: {
        list: async (clinicId) => {
          calls.push({ list: clinicId });

          return [row];
        },
        create: async (clinicId, input) => {
          calls.push({ create: [clinicId, input] });

          return row;
        },
        update: async (clinicId, id, patch) => {
          calls.push({ update: [clinicId, id, patch] });
          if (id !== "t-1") throw new TreatmentNotFoundError();

          return row;
        },
        remove: async (clinicId, id) => {
          calls.push({ remove: [clinicId, id] });
          if (id !== "t-1") throw new TreatmentNotFoundError();
        }
      }
    })
  );
  app.use(errorHandler);

  return { app, calls };
};

const send = async (app: express.Express, method: string, path: string, body?: unknown) => {
  const server = app.listen(0);

  try {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const response = await fetch(`http://127.0.0.1:${port}/api/v1${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined || method === "GET" ? undefined : JSON.stringify(body)
    });
    const text = await response.text();

    return { status: response.status, body: text ? JSON.parse(text) : null };
  } finally {
    server.close();
  }
};

describe("treatments routes", () => {
  it("lists for the clinic named in the path", async () => {
    const { app, calls } = buildApp();
    const res = await send(app, "GET", "/clinics/aurea/treatments");

    expect(res.status).toBe(200);
    expect(res.body).toEqual([row]);
    expect(calls).toEqual([{ list: "clinic-1" }]);
  });

  it("404s an unknown clinic on every verb", async () => {
    const { app } = buildApp();

    for (const [method, path] of [
      ["GET", "/clinics/nope/treatments"],
      ["POST", "/clinics/nope/treatments"],
      ["PATCH", "/clinics/nope/treatments/t-1"],
      ["DELETE", "/clinics/nope/treatments/t-1"]
    ]) {
      expect((await send(app, method, path, { name: "A", priceEuro: 1 })).status).toBe(404);
    }
  });

  it("creates with a 201 and passes the validated body", async () => {
    const { app, calls } = buildApp();
    const res = await send(app, "POST", "/clinics/aurea/treatments", {
      name: "  Limpieza ",
      priceEuro: 45,
      categoryId: "FAC",
      costPct: 0.9
    });

    expect(res.status).toBe(201);
    expect(res.body).toEqual(row);
    // The owner never enters cost, so an extra field is dropped rather than forwarded.
    expect(calls).toEqual([
      { create: ["clinic-1", { name: "Limpieza", priceEuro: 45, categoryId: "FAC" }] }
    ]);
  });

  it.each([
    [{ priceEuro: 10 }, "Escribe el nombre del tratamiento."],
    [{ name: "A" }, "El precio debe estar entre 0,01 € y 100.000 €."],
    [{ name: "A", priceEuro: "10" }, "El precio debe estar entre 0,01 € y 100.000 €."],
    [{ name: "A", priceEuro: 0 }, "El precio debe estar entre 0,01 € y 100.000 €."],
    [{ name: "A", priceEuro: -1 }, "El precio debe estar entre 0,01 € y 100.000 €."],
    [{ name: "A", priceEuro: 100001 }, "El precio debe estar entre 0,01 € y 100.000 €."],
    [{ name: "A", priceEuro: 1.234 }, "El precio debe estar entre 0,01 € y 100.000 €."],
    [{ name: " ", priceEuro: 5 }, "Escribe el nombre del tratamiento."]
  ])("rejects %j with a 400 and the bare Spanish message", async (body, message) => {
    const { app, calls } = buildApp();
    const res = await send(app, "POST", "/clinics/aurea/treatments", body);

    expect(res.status).toBe(400);
    expect(res.body.message).toBe(message);
    expect(calls).toEqual([]);
  });

  it("answers a service validation error with its Spanish message", async () => {
    const { app } = buildApp();
    const failing = express();
    failing.use(express.json());
    failing.use(
      "/api/v1",
      createTreatmentsRouter({
        findClinic: async () => ({ id: "c" }),
        catalogue: {
          list: async () => [],
          create: async () => {
            throw new TreatmentValidationError("Elige una categoría de la lista.");
          },
          update: async () => row,
          remove: async () => {}
        }
      })
    );
    failing.use(errorHandler);

    const res = await send(failing, "POST", "/clinics/x/treatments", { name: "A", priceEuro: 5 });

    expect(app).toBeDefined();
    expect(res.status).toBe(400);
    expect(res.body.message).toBe("Elige una categoría de la lista.");
  });

  it("patches, and 404s an id the clinic does not own", async () => {
    const { app, calls } = buildApp();

    const ok = await send(app, "PATCH", "/clinics/aurea/treatments/t-1", { name: "Nuevo" });
    expect(ok.status).toBe(200);
    expect(calls).toEqual([{ update: ["clinic-1", "t-1", { name: "Nuevo" }] }]);

    const missing = await send(app, "PATCH", "/clinics/aurea/treatments/other", { name: "X" });
    expect(missing.status).toBe(404);
    expect(missing.body.message).toBe("No se ha encontrado ese tratamiento.");

    const bad = await send(app, "PATCH", "/clinics/aurea/treatments/t-1", { priceEuro: 0 });
    expect(bad.status).toBe(400);
    expect(bad.body.message).toBe("El precio debe estar entre 0,01 € y 100.000 €.");
  });

  it("deletes, and 404s an id the clinic does not own", async () => {
    const { app } = buildApp();

    expect((await send(app, "DELETE", "/clinics/aurea/treatments/t-1")).status).toBe(200);

    const missing = await send(app, "DELETE", "/clinics/aurea/treatments/other");
    expect(missing.status).toBe(404);
    expect(missing.body.message).toBe("No se ha encontrado ese tratamiento.");
  });
});
