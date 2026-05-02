#!/bin/bash
# Annotation: Strip annotation comments before commit
# @todo, @bookmark, @review, @warn, @breakpoint, @local 패턴 제거
sed -E '/\/\/[[:space:]]*@(todo|bookmark|review|warn|breakpoint|local)([[:space:]]|$)/d; /\/\*[[:space:]]*@(todo|bookmark|review|warn|breakpoint|local)([[:space:]]|$)/d' || true
