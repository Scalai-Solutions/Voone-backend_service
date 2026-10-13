# Motor de onboarding de Voone
## Especificación técnica v1.2 (motor 1.2.0, configuración 2026-10-07.1)

Este documento describe cómo el backend genera el programa de fidelización completo de un centro (umbrales, premios, niveles, ventajas, referidos y economía) a partir de su catálogo y de 4 respuestas. Va acompañado de una implementación de referencia en TypeScript (`src/engine.ts`), su configuración (`src/config.json`) y un caso de prueba real (`fixtures/sapphira.json` con su salida esperada `fixtures/sapphira.expected.json`).

La implementación de referencia reproduce exactamente el Excel `Voone_Motor_Onboarding_v0.6_Sapphira.xlsx` validado por los socios. Si el backend se reescribe en otro lenguaje, debe producir la misma salida para el mismo caso de prueba.

## Cambios de la versión 1.2 (2026-10-07)

Mandan sobre la versión 1.1 y sobre el resto del documento.

- **Bronce, mejor premio primero.** Tras elegir la escalera, los tres premios del primer tramo se reordenan: el de mayor valor pasa al primer hito y los otros dos siguen de menor a mayor. El resto de tramos mantiene el orden creciente.
- **Diagnóstico siempre en Bronce.** Si el catálogo tiene algún artículo DIA clasificado, la primera ventaja del primer tramo es un diagnóstico gratis. El diagnóstico ya no aparece en otros tramos.
- **Puntos dobles en cada nivel.** Cada tramo tiene siempre una ventaja de puntos dobles en la siguiente visita de pago.
- **Hitos por tramo.** hitos = max(3 premios + ventajas fijas, ceil(visitas reales / 1,5) − 1), con ventajas fijas = 1 (puntos dobles) + 1 en el primer tramo si hay diagnóstico. Las ventajas restantes rotan entre mejora del tratamiento y premio sorpresa.
- **Bonos.** Los puntos se suman en cada sesión consumida, nunca de golpe al comprar el bono.
- **Happy Hour.** Oro, Platino y Diamante tienen acceso preferente a los huecos que el centro marca para llenar rápido, con un 30% de descuento. Sustituye a la reserva anticipada de 24 y 48 horas.
- **Clientas al año.** Es la sexta pregunta del onboarding (`members`). No cambia el programa.

---

## Cambios de la versión 1.1 (2026-10-06)

Esta sección manda sobre el resto del documento allí donde se contradigan. La referencia ejecutable pasa a ser `src/engine.cjs` (JavaScript, el mismo motor que usa el simulador interno), con su caso de prueba `fixtures/sapphira.catalogo.json` y la salida esperada `fixtures/sapphira.expected.json`. La versión 1.0 en TypeScript queda en `legacy-v1.0/` solo como histórico. Para comprobar: `npm run ejemplo`.

### Alcance
- Solo centros médico-estéticos. Siempre 5 niveles y 5 años hasta Diamante. No hay pregunta de duración.
- Respuestas del centro: ticket, frecuencia, objetivo, inversión y ocupación de la agenda (`occupancy`: o1 a o4). El número de clientas (`members`) solo se usa para la economía interna.
- Se eliminan los regalos de aniversario.

### Hitos por tramo (sustituye a 5.4)
- Cada tramo tiene `premiosPerTramo` = 3 premios del catálogo.
- Hitos del tramo = max(3, ceil(visitas reales del tramo / `maxVisitsBetween`) − 1), con `maxVisitsBetween` = 1,5. Visitas reales = tramo × visitas al año / multiplicador de progreso del nivel.
- Los premios ocupan las posiciones round(1 + j × (hitos − 1) / 2), j = 0, 1, 2. El resto de hitos son ventajas.

### Ventajas intercaladas (`choosePerks`)
Se asignan en orden fijo y rotando, saltando las que el catálogo no permite. Ninguna es un descuento.

| Tipo | Contenido | Coste imputado |
|---|---|---|
| diag | Artículo de categoría DIA del catálogo, gratis | 0 |
| doble | Puntos dobles en la próxima visita de pago | inversión × ticket |
| mejora | Mejora del tratamiento o 10 minutos extra | `perkUpgradeCost` (5%) × ticket |
| sorpresa | Un regalo del fondo de regalos sencillos, a elección del centro | coste medio del fondo |

Fondo de sorpresa: candidatos de categoría COS o PRE, o con coste/valor ≤ `surpriseRatio` (6%), y coste ≤ `surpriseMaxCost` (10%) del ticket. El coste de las ventajas se suma al coste total del programa.

### Canje
Todo premio, ventaja y regalo de cumpleaños se canjea únicamente en una visita de pago o en una sesión de un bono ya pagado, y caduca a los 60 días. El backend debe validar que existe un cobro o un consumo de bono en la misma visita.

### Ocupación de la agenda
Tabla `occupancy`: `svc` multiplica el coste de los regalos que consumen tiempo de cabina (`timeCats`) y divide el valor objetivo de cada premio; `tramo` pondera el presupuesto por tramo junto con el objetivo; `ref` multiplica el valor objetivo de los premios de referidos. Valores: o1 0,7 / [1,15, 1, 1, 1] / 1,5; o2 1 / [1, 1, 1, 1] / 1; o3 1,2 / [1,05, 0,9, 1, 1,1] / 0,8; o4 1,4 / [1,1, 0,8, 1, 1,2] / 0,6.

### Cascada de relajación (sustituye el orden de 5.5)
Tras el intento sin relajar, primero se amplía la tolerancia de presupuesto por premio (30% y 50%) manteniendo el tope de valor en 2 veces el objetivo. Solo si no hay solución se sube el tope de valor a 3 veces, y después se sigue con el resto de pasos (tratamientos en el primer tramo, repetidos, packs). El orden exacto es el array `steps` de `run`.

### Niveles
- Descuento en cosmética: Plata 3%, Oro 5%, Platino 10%, Diamante 15%, con un máximo de `discountMaxProducts` = 3 productos al año.
- Elegir hueco antes que el resto: 24 horas desde Oro, 48 horas en Platino y Diamante.
- Family & Friends: nivel aparte y estático. El centro añade personas a mano y define sus ventajas. No acumula puntos, no tiene hitos, no sube de nivel y queda fuera de todos los cálculos.

### Referidos escalados (`chooseReferral`, sustituye a 5.7)
- Un referido cuenta cuando la persona nueva hace su primer pago de un tratamiento. La cuenta es acumulada y no caduca.
- Premios en los referidos 1, 3, 5, 7 y 10 (`refSteps`), con valor objetivo de 30%, 75%, 125%, 175% y 275% del ticket, multiplicado por el factor de objetivo y el de ocupación.
- Tope de coste de cada premio: `refInv` (10%) × facturación de primer año de una clienta nueva × referidos desde el premio anterior. Facturación de primer año = s0 × A + (1 − s0) × gasto de una ocasional.
- Se elige la opción (un artículo o un par de categorías distintas) más cercana al objetivo, con valor mayor que el premio anterior y sin repetir artículos. Desempates: menos artículos, menor coste, orden de id.
- Después del décimo, cada `refRepeatEvery` = 3 referidos se repite el premio del décimo.
- La persona nueva empieza con el 50% del primer umbral como progreso, redondeado a 5 €.

### Economía (sustituye a 5.8)
- Socias = clientas × `adhesion` (50%). Repetidoras = socias × s1 (42% + 10 puntos). Ocasionales: 1,3 visitas, siempre Bronce.
- Reparto de repetidoras por antigüedad: cada año sigue el `repeatRetention` (75%) del anterior, horizonte de 10 años. El nivel de cada una sale de su gasto acumulado. Premios y ventajas de nivel se calculan con ese reparto, no con una media uniforme.
- Ingresos: socias que pasan a repetir; gasto extra del 5% de las repetidoras; canjes que traen una visita de pago adicional (`redeemVisitShare` = 10% de los canjes × ticket); clientas nuevas por referidos (`refShare` = 5% de las socias trae una al año).
- Costes: premios y ventajas canjeados (75%), ventajas de nivel, premios de referidos y progreso de bienvenida, cuota.
- Se calcula además el resultado del primer año, en el que todas las socias empiezan en Bronce.
- `redeemVisitShare` y `refShare` son hipótesis sin medir. Deben recalibrarse con datos reales del piloto.

---

## 1. Principios

1. **Determinista.** Mismo catálogo, mismas respuestas y misma configuración producen siempre el mismo programa. No hay azar: todos los empates se resuelven con reglas fijas (sección 5.6).
2. **Los números viven en la configuración, no en el código.** Pesos, intervalos, costes, porcentajes y reglas están en `config.json`, que controla Voone. Recalibrar es cambiar un valor, no desplegar código.
3. **Versionado.** Cada programa guarda `engineVersion` y `configVersion`. Un cambio de configuración nunca modifica programas ya publicados sin una acción explícita.
4. **El motor propone, el centro aprueba.** La salida es un borrador completo. El centro lo revisa, puede cambiar premios por las alternativas propuestas y lo activa.

---

## 2. Flujo de onboarding (objetivo: menos de 5 minutos para el centro)

| Paso | Qué hace el centro | Qué hace el sistema |
|---|---|---|
| **A. Catálogo** | Sube un CSV o introduce sus tratamientos y productos a mano | Clasifica cada fila por palabras clave (sección 5.1) y marca las dudosas |
| **B. Revisión de dudas** | Solo si hay filas sin clasificar: elige su categoría en un desplegable | Recalcula |
| **C. Pregunta 1: ticket medio** | Confirma el rango precargado o elige otro | Precarga el rango a partir del catálogo (sección 5.2) |
| **D. Pregunta 2: frecuencia** | Confirma el rango precargado o elige otro | Igual |
| **E. Pregunta 3: objetivo** | Elige: equilibrado, más visitas, más gasto o más clientes nuevos | |
| **F. Pregunta 4: inversión** | Elige: conservador (4%), equilibrado (5%) o generoso (6%) | Por defecto, equilibrado |
| **G. Resumen** | Revisa escalera, ventajas y economía. Puede cambiar un premio por una de sus alternativas | Ejecuta el motor completo y las validaciones |
| **H. Activar** | Pulsa "Activar programa" | Publica la versión, genera la clase de Wallet y el cartel con QR |

Recomendación de producto: pedir en el paso A que el centro incluya **al menos 5 productos de venta** y **la presoterapia** si la ofrece. Son los premios de los primeros tramos; sin ellos, los primeros premios empeoran.

---

## 3. Entradas

### 3.1 Catálogo (CSV o formulario)

| Columna | Obligatoria | Tipo | Notas |
|---|---|---|---|
| `id` | Sí | texto | Identificador estable. Si el centro no lo da, lo genera el sistema |
| `name` | Sí | texto | Nombre tal como lo vende el centro |
| `price` | Sí | número | Precio de venta en euros, IVA incluido |
| `durationMin` | No | número | Minutos |
| `isProduct` | No | sí/no | Producto de venta al público (cosmética). Se clasifica como `COS` |
| `categoryId` | No | código | Si viene vacío, lo asigna el motor |
| `costPctOverride` | No | 0-1 | Coste real del centro como % del precio, si lo conoce |
| `estimated` | No | sí/no | Fila añadida por Voone como estimación. No cuenta para estimar el ticket |

Un precio con rango (por ejemplo "410-450€") se guarda como su punto medio y se marca para revisión.

### 3.2 Respuestas

```json
{ "ticketBucketId": "t2", "frequencyBucketId": "f3", "objective": "equilibrado", "investment": "equilibrado" }
```

`ticketBucketId` y `frequencyBucketId` son opcionales: si faltan o coinciden con el rango precargado, se usa la estimación exacta del motor.

### 3.3 Supuestos económicos (opcionales)

Solo afectan al informe económico, no a la escalera: margen de contribución (60%), socios activos (200), cuota mensual de Voone (149,99€), retención base (52%) y mejora de retención (+10 puntos). Valores por defecto en `economicsDefaults`.

---

## 4. Configuración (`config.json`)

| Bloque | Qué contiene | Quién lo cambia |
|---|---|---|
| `categories` | Por categoría: peso de demanda, intervalo de repetición, coste como % del precio, si suma puntos, si puede ser premio, si se permite en el primer tramo y si es farmacológica | Voone, al recalibrar |
| `segmentRules` | Qué categorías convierten un centro en high o mid | Voone |
| `segments` | Factor de combinación, factor de cumplimiento, rango de ticket de referencia y valor del referido | Voone |
| `ticketBuckets`, `frequencyBuckets` | Opciones de las preguntas 1 y 2 | Voone |
| `investmentLevels` | 4%, 5% y 6% | Voone |
| `objectives` | Por objetivo: pesos de los 3 premios del tramo, multiplicador de inversión por tramo, multiplicador de referido e impulsos activos | Voone |
| `params` | Tolerancia (15%), valor devuelto objetivo (30%), tope de valor (2×), redondeo (10€), años hasta Diamante (5), crecimiento mínimo (1,5), visitas para Plata (3), premios por tramo (3), premio recurrente (cada 0,75 A), anchura de búsqueda (400) y reglas de funcionamiento | Voone |
| `tiers` | Niveles y antigüedad mínima: Oro 12 meses, Platino 24, Diamante 36 | Voone |
| `benefits` | Ventajas por nivel y segmento, con coste anual estimado y marca de revisión legal | Voone |
| `keywordRules` | Palabras clave para clasificar el catálogo, en orden de prioridad | Voone |

Todo cambio en este archivo incrementa `configVersion`.

---

## 5. Algoritmo

Notación: **T** = ticket medio; **F** = visitas al año de un cliente habitual; **A** = T × F, gasto anual de un cliente habitual. Todos los umbrales se expresan en euros acumulados.

Redondeo: siempre "como Excel" (la mitad se aleja del cero). No usar el redondeo bancario por defecto de algunos lenguajes.

### 5.1 Clasificar el catálogo (`classifyCatalog`)

Para cada fila, en este orden:
1. Si trae `categoryId` válido, se respeta.
2. Si `isProduct` es verdadero, categoría `COS`.
3. Se recorren `keywordRules` en orden; la primera regla cuyo término aparezca en el nombre (en minúsculas) asigna la categoría. El orden importa: las reglas de medicina y diagnóstico van primero para que "Diagnóstico de láser" no se clasifique como láser.
4. Si nada coincide, se marca `needsReview` y el centro debe elegir la categoría (paso B).

### 5.2 Segmento, ticket y frecuencia (`detectSegment`, `estimate`)

- **Segmento:** high si hay alguna fila de una categoría de `highIfAnyCategory` (farmacológica); si no, mid si hay alguna de `midIfAnyCategory`; si no, low.
- Para cada categoría con peso de demanda > 0, que suma puntos y tiene filas no estimadas: **mediana** de sus precios.
- **T estimado** = redondeo( factor de combinación × Σ(peso × mediana) / Σ peso ).
- **F estimada** = redondeo a 1 decimal( factor de cumplimiento × Σ(peso × 52 / intervalo) / Σ peso ).
- Rango precargado: el primer rango cuyo máximo supera la estimación.
- Si el centro elige otro rango, se usa el valor representativo de ese rango.

En high, la medicina no entra en el cálculo (no suma puntos), así que el ticket y la frecuencia se estiman solo con los tratamientos no farmacológicos.

### 5.3 Tramos entre niveles (`buildLadder`)

1. **Plata** en veces A: `P = visitasParaPlata × T / A`.
2. **Crecimiento R** entre tramos: la solución de `1 + R + R² + R³ = añosHastaDiamante / P`, por Newton (6 iteraciones desde R = 1,5). Si R < crecimiento mínimo, se usa el mínimo y Diamante se alarga.
3. **Saltos**: tramo k (k = 0..3) mide `P × R^k` veces A. Años reales hasta Diamante = suma de saltos.
4. **Presupuesto del tramo** = inversión × salto × A × multiplicador normalizado, donde el multiplicador normalizado del tramo k es `mult_k × añosReales / Σ(mult_j × salto_j)`. Así el total siempre es exactamente el % de inversión, aunque el primer tramo reciba más.

### 5.4 Hitos

Cada tramo tiene 3 premios y termina en un nivel (sin regalo):
- Premio j (j = 1..3) en `A × (inicio + salto × j / 4)`, redondeado a 10€.
- Presupuesto de coste del premio j = presupuesto del tramo / 3 × peso de posición j (por defecto 0,8, 1,0 y 1,2).
- Tope = presupuesto × (1 + tolerancia).
- Valor objetivo = presupuesto / inversión × valor devuelto objetivo.
- Nivel al final del tramo en `A × fin`, redondeado a 10€.

Dos ajustes fijos:
- **Primer premio en la primera visita:** su umbral es el mínimo entre el calculado y el ticket redondeado a la baja a 10€.
- **Plata se redondea a la baja**, para que N visitas al ticket medio siempre la alcancen.

### 5.5 Elección de premios (`chooseRewards`)

Candidatos: filas cuya categoría puede ser premio. Coste = precio × (`costPctOverride` o % de la categoría). Para cada premio se generan las opciones: cada candidato solo y cada pareja de candidatos de **categorías distintas** (packs). Se descartan las opciones con coste mayor que el tope o valor mayor que el tope de valor × valor objetivo. En el tramo 1 solo se admiten categorías con `earlyAllowed` (cosmética y presoterapia).

Reglas duras de la escalera:
- cada premio vale **estrictamente más** que el anterior;
- ningún artículo se repite en toda la escalera.

Se elige la escalera completa, no premio a premio, mediante **búsqueda en haz**:

```
haz = [ {puntuación: 0, últimoValor: 0, usados: {}, camino: []} ]
para cada premio i:
    siguientes = []
    para cada estado en haz, para cada opción de premio i:
        si opción.valor <= estado.últimoValor o comparte artículos con estado.usados: saltar
        añadir estado nuevo con puntuación += |opción.valor − objetivo_i| / objetivo_i
    si siguientes está vacío: ERROR "sin solución en el premio i"
    ordenar siguientes (sección 5.6) y quedarse con los 400 primeros
resultado = primer estado del haz
```

Para cada premio elegido se guardan hasta 2 **alternativas**: opciones dentro de su tope, con valor entre el premio anterior y el siguiente, que no usen artículos de otros premios. Son las que el centro puede elegir en el resumen sin romper la escalera.

**Premio recurrente de Diamante:** cada `0,75 × A` euros. Valor objetivo = 30% de ese importe; tope de coste = inversión × ese importe × 1,15. Se elige la opción más cercana al objetivo con valor ≥ el último premio; puede repetir artículos.

### 5.6 Desempates (obligatorios para que el resultado sea determinista)

- En la búsqueda en haz: menor puntuación; después, mayor último valor; después, comparación lexicográfica de las listas de identificadores del camino.
- En alternativas y premio recurrente: menor distancia al objetivo; después, menos artículos; después, menor coste; después, identificadores.

### 5.7 Referidos, ventajas e impulsos

- **Premio de referido:** el candidato cuyo valor está más cerca de `% del segmento × T × multiplicador del objetivo`; desempate por menor coste y después por identificador. Solo se activa cuando el nuevo cliente viene y paga. Tope de 10 al año.
- **Bienvenida del referido:** progreso inicial = 50% del umbral del primer premio.
- **Ventajas por nivel:** las de `benefits` que corresponden al segmento. Las marcadas con `legalReview` para el segmento del centro se muestran con aviso.
- **Impulsos:** los del objetivo elegido.

### 5.8 Economía (`economics`)

Para cada hito, valores acumulados de un cliente habitual:
- años = umbral / A;
- ha gastado = umbral;
- regalado (valor y coste) = suma de los premios hasta ese hito;
- margen = umbral × margen de contribución;
- cuota imputada = cuota mensual × 12 × años / socios;
- **beneficio neto = margen − coste de regalos − cuota imputada**.

Lo que genera el programa de verdad:
- vida media sin programa `1/(1−r)` y con programa `1/(1−r−Δ)`;
- ingreso incremental por socio = A × diferencia de vidas;
- beneficio neto por socio = ingreso incremental × margen − coste de los premios que alcanza un socio medio − cuota por socio.

### 5.9 Validaciones

| Validación | Si falla |
|---|---|
| Primer premio en la primera visita | Error de motor: revisar |
| Premios estrictamente crecientes | Error de motor: revisar |
| Todos los premios dentro de su tope | Error de motor: revisar |
| Ningún artículo repetido | Error de motor: revisar |
| Crecimiento ≥ mínimo | Error de configuración |
| Diamante entre 3 y 5 años | Aviso: revisar años o visitas para Plata |
| Coste total ≤ inversión elegida | Error de motor: revisar |
| Ticket dentro del rango de referencia | Aviso: confirmar ticket con el centro |
| Sin filas sin clasificar | Bloquea: el centro debe clasificarlas |
| Sin relajaciones | Aviso: el catálogo tiene pocos premios posibles |

Si todas pasan, el estado es `borrador_listo`; si alguna falla, `requiere_revision` y el caso pasa al equipo de Voone.

Si la búsqueda en haz no encuentra solución (catálogo con pocos premios posibles), el motor aplica estas relajaciones en orden, las anota en `relaxations` y marca el programa para revisión: 1) tope de valor de 2 a 3; 2) además, multiplicador de inversión del tramo 1 de 2 a 2,5. Si aun así no hay solución, devuelve un error controlado y se pide al centro que añada productos o regalos de bajo coste.

---

## 6. Salida

Objeto `Program` (ejemplo completo en `fixtures/sapphira.expected.json`):

| Campo | Contenido |
|---|---|
| `engineVersion`, `configVersion` | Versiones con las que se generó |
| `status`, `checks` | Estado y resultado de cada validación |
| `estimates` | Segmento, ticket y frecuencia estimados y usados, A, rangos precargados, medianas por categoría |
| `ladder.milestones[]` | 16 hitos: número, tramo, tipo (premio o nivel), nivel, umbral, presupuesto, tope, valor objetivo, premio (artículos, valor y coste) y alternativas |
| `ladder.recurring` | Premio recurrente de Diamante y cada cuántos euros |
| `tiers[]` | Cada nivel con su umbral, antigüedad mínima y ventajas |
| `referral` | Premio de referido, progreso de bienvenida y tope anual |
| `impulses` | Impulsos activos |
| `rules` | Caducidad de premios, revisión de nivel, regla de mantenimiento y acumulación de bonos |
| `economics` | Tabla hito a hito y resumen del programa |
| `catalog` | Catálogo clasificado, con origen de cada clasificación |

---

## 7. Reglas de funcionamiento en producción

Estas reglas no las ejecuta el motor, sino el sistema de puntos en el día a día. El motor las incluye en `rules` para que cada programa las lleve consigo.

1. **Acumulación:** 1 € pagado en un tratamiento o producto que suma puntos = 1 € de progreso. Al cliente se le muestra "te faltan X € para tu próximo premio", nunca puntos.
2. **Bonos:** el progreso se suma al **consumir cada sesión** (precio del bono / nº de sesiones), no al comprarlo. La ventana de cobro debe distinguir "venta de bono" y "consumo de sesión".
3. **Medicina estética:** los tratamientos farmacológicos no suman progreso; la ventana de cobro separa el importe que suma.
4. **Subida de nivel:** requiere el umbral **y** la antigüedad mínima del nivel. Si el cliente alcanza el umbral antes, sube cuando cumple la antigüedad.
5. **Mantenimiento del nivel:** revisión cada 12 meses; si no ha conseguido al menos 1 premio en ese periodo, baja un nivel (nunca por debajo de Bronce). El progreso y los premios conseguidos no se pierden.
6. **Caducidad:** cada premio desbloqueado debe usarse en 60 días.
7. **Premios de servicio:** se canjean en huecos que el centro marca como libres.
8. **Libro de movimientos:** el progreso es un registro de movimientos que solo se añaden (nunca se editan). Una corrección es un movimiento compensatorio con motivo y usuario.

### 7.1 Recalibración a los 90 días

A los 90 días el sistema tiene el ticket y la frecuencia reales. Si difieren más de un 15% de los usados, se ejecuta el motor con los valores reales y se propone el cambio al centro. **Solo se modifican los hitos que ningún cliente ha alcanzado todavía**; los ya alcanzados o en curso se mantienen para no mover la meta a nadie. El nuevo programa se guarda como una versión nueva.

### 7.2 Cambios del centro después de activar

- Cambiar un premio por una alternativa: se permite en cualquier momento para hitos no alcanzados.
- Cambiar precios del catálogo: no recalcula umbrales automáticamente; se propone en la siguiente recalibración.
- Cambiar objetivo o inversión: genera una versión nueva con la misma regla de hitos no alcanzados.

---

## 8. Modelo de datos sugerido

| Tabla | Campos principales |
|---|---|
| `catalog_items` | center_id, item_id, name, price, duration_min, is_product, category_id, cost_pct_override, estimated, classification_source, needs_review |
| `engine_configs` | config_version, json, created_at |
| `programs` | program_id, center_id, version, engine_version, config_version, status, answers_json, output_json, published_at |
| `milestones` | program_id, n, tramo, type, tier_id, threshold, reward_json, alternatives_json |
| `tier_benefits` | program_id, tier_id, text, annual_cost, needs_legal_review |
| `ledger_entries` | member_id, center_id, amount_eur, source (cobro, sesión de bono, referido, corrección), related_id, created_at, created_by |
| `member_rewards` | member_id, program_id, milestone_n, unlocked_at, expires_at, redeemed_at, redeemed_by |

---

## 9. API sugerida

| Método | Ruta | Qué hace |
|---|---|---|
| POST | `/centers/{id}/catalog` | Sube el CSV; devuelve el catálogo clasificado y las filas dudosas |
| PATCH | `/centers/{id}/catalog/{itemId}` | Corrige categoría, precio o coste de una fila |
| GET | `/centers/{id}/onboarding/estimates` | Devuelve segmento, ticket, frecuencia y rangos precargados |
| POST | `/centers/{id}/programs/draft` | Ejecuta el motor con las respuestas; devuelve el borrador |
| PATCH | `/programs/{pid}/milestones/{n}` | Cambia un premio por una alternativa; revalida |
| POST | `/programs/{pid}/publish` | Publica la versión y crea la clase de Wallet |

---

## 10. Pruebas

1. **Caso de referencia:** `fixtures/sapphira.json` debe producir exactamente `fixtures/sapphira.expected.json` (ejecutar `npx tsx src/run.ts fixtures/sapphira.json salida.json`).
2. **Determinismo:** ejecutar 100 veces el mismo caso y comparar las salidas byte a byte.
3. **Propiedades** en catálogos generados al azar: premios estrictamente crecientes, sin repeticiones, coste ≤ tope, coste total ≤ inversión, primer premio ≤ ticket, Plata alcanzable con las visitas fijadas.
4. **Catálogos límite:** sin productos, solo medicina, un único tratamiento, precios con rango; deben terminar en `requiere_revision` o en un error controlado con un mensaje claro para el centro (por ejemplo, un catálogo sin productos ni presoterapia no tiene premios posibles para el primer tramo).

---

## 11. Pendiente de decidir antes de producción

| Tema | Estado |
|---|---|
| Pesos, intervalos y costes por categoría | Hipótesis de Voone; recalibrar con datos del piloto |
| Coste real de la cosmética (50%) y de la presoterapia (5%) | Hipótesis; pedir datos a los centros |
| Bio-Pen y otros tratamientos con dispositivo en high | Confirmar si el centro los trata como acto médico |
| Actos médicos no farmacológicos | Excluidos de puntos hasta tener opinión legal |
| Ventajas por nivel con revisión legal en high | Pendiente de opinión legal |
| Precios de Voone por segmento | Pendiente de unificar (afecta solo al informe económico) |
| Multiplicadores de puntos por nivel | Fuera de la v1: aceleran la escalera y alteran la economía |
