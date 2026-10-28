// Syntax-only smoke test for Supabase/Deno TypeScript source. No external calls.
const fs=require('node:fs');
const path=require('node:path');
const {execFileSync}=require('node:child_process');
let ts;
try {ts=require('typescript');}
catch {
 try {ts=require(path.join(execFileSync('npm',['root','-g'],{encoding:'utf8'}).trim(),'typescript'));}
 catch {console.error('TypeScript nicht installiert; optional: npm install --global typescript');process.exit(1);}
}
const name=path.resolve(__dirname,'../supabase/functions/close-month/index.ts');
const result=ts.transpileModule(fs.readFileSync(name,'utf8'),{
 fileName:name, compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext},reportDiagnostics:true
});
const issues=result.diagnostics.filter(x=>x.category===ts.DiagnosticCategory.Error);
if(issues.length){for(const i of issues)console.error(ts.flattenDiagnosticMessageText(i.messageText,'\n'));process.exit(1);}
console.log('Supabase Edge Function: TS-Syntax OK (kein Live-Betriebstest)');
