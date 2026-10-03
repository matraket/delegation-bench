Como prometí, aquí van los resultados de la muestra ampliada con NaN Builders. Es una réplica independiente de tu método, sobre las reglas que salieron en Gentleman-Programming/gentle-shell#1590.

Lo más útil, en una línea: con estos modelos la regla del presupuesto de evidencia casi nunca se dispara; delegar en sesiones largas ahorra cuota cuando la caché se cobra entera, pero cuesta precisión en las respuestas.

**Montaje**

- Gentle Shell (paquetes `1162ce90` y `2549f17a`, con las reglas idénticas a #1590; las preguntas, fijadas en `cc36bd8d`), un home aislado por sesión y una copia del paquete por variante (`--package-root`).
- 4 variantes: reglas anteriores a #1590, inline forzado, regla actual (presupuesto de evidencia) y delegación forzada.
- 12 preguntas sobre Gentle Shell fijado en un commit (4 pequeñas, 4 medianas, 4 grandes), cada una con su pregunta de detalle y una clave de hechos verificados con `path:line`.
- Sesiones cortas (2 turnos) con glm5.3-flash, deepseek-v4-flash y qwen3.8-flash; sesiones largas (24 turnos, 3 repeticiones) con glm5.3-flash y deepseek-v4-flash. 168 sesiones en total, todas completas.
- El costo sale de los JSONL de las sesiones y coincide exactamente con lo que factura NaN. NaN cuenta las lecturas de caché enteras (lo medí), así que doy dos columnas: pesos de NaN (todo a 1) y tus pesos de API (caché 0,1).

**1. La regla casi nunca se cumple**

| Modelo | Sesiones cortas que delegaron (regla actual) | Turnos por encima del presupuesto | Sesiones cortas que delegaron (reglas anteriores) |
|---|---|---|---|
| glm5.3-flash | 0 de 12 | 9 de 24 | 0 de 12 |
| deepseek-v4-flash | 1 de 12 | 12 de 24 | 3 de 12 |
| qwen3.8-flash | 1 de 12 | 14 de 24 | 6 de 12 |

En las sesiones largas, la regla actual delegó 0 veces en 72 turnos con glm5.3-flash y 1 vez con deepseek-v4-flash. Coincide con lo que viste con las reglas anteriores y con el problema que plantea #3411: escrita como prosa, la regla no se aplica.

**2. El costo depende de cómo se cobre la caché**

| Sesión larga, delegación forzada frente a inline | glm5.3-flash | deepseek-v4-flash |
|---|---|---|
| Pesos de NaN (caché a 1) | 0,44x | 0,72x |
| Pesos de API (caché a 0,1) | 1,25x a 1,45x | 1,18x |
| Contexto final del padre | -50% | -35% |

Con preguntas cortas, delegar costó 1,03x, 1,60x y 1,85x frente a inline (glm, deepseek, qwen). Todo encaja con tu modelo de costos: lo que cambia la conclusión es el precio de la caché.

**3. Delegar baja la calidad de las respuestas**

Califiqué las 864 respuestas a ciegas contra la clave de hechos, con gpt-6.1-sol como juez. Antes lo calibré contra una referencia independiente sobre 30 respuestas: coincidió en 156 de 156 hechos.

- Delegación forzada frente a inline: -11 puntos de hechos cubiertos (IC 95%: -14,5 a -7,6). Fue peor en 89 turnos emparejados y mejor en 11.
- En preguntas grandes, -22 puntos. En las de detalle, -5.
- Las tres variantes inline (reglas anteriores, regla actual, inline forzado) no se distinguen entre sí.
- Lo que se pierde son detalles exactos (nombres de eventos, códigos de salida, textos de error), que el resumen del hijo no trae de vuelta.

Tu estudio encontró un techo de calidad; con claves de hechos más estrictas aparece este costo.

**Otros datos**

- Delegar tardó entre 1,6 y 2,3 veces más.
- En mi Gentle Shell real, los paquetes adicionales (gentle-engram, pi-web-access, pi-btw, pi-mcp-adapter, pi-claude-bridge) casi duplican el prefijo del padre: 38k frente a 18k tokens.
- Una sesión larga con delegación forzada (deepseek) respondió 22 de 24 turnos en español pese a pedirse inglés. Ninguna otra sesión derivó.

**Límites**

Un solo repositorio, preguntas de lectura (no de escritura), una repetición en las sesiones cortas, el texto de las variantes inline y delegación forzada es mío, y los subagentes en segundo plano estaban desactivados.

Si te sirven, puedo compartir el arnés y los datos.
