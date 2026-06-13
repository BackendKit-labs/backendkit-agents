#!/bin/bash

# Pruebas de RAG contra el vault de bk-agent
cat << 'QUERIES' | npm start 2>&1 | head -150
¿Cuáles son las 5 fases de /spec?
/quit
QUERIES
