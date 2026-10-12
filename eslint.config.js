import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';
export default tseslint.config({ignores:['dist/**','node_modules/**','.wrangler/**','adapters/fixtures/**']}, js.configs.recommended,...tseslint.configs.recommended,{languageOptions:{globals:{...globals.browser,...globals.node}},rules:{'no-control-regex':'off','no-empty':['error',{allowEmptyCatch:true}],'@typescript-eslint/no-explicit-any':'off','@typescript-eslint/no-unused-vars':['error',{argsIgnorePattern:'^_',varsIgnorePattern:'^_'}]}});
