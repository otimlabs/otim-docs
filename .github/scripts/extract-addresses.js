#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

// Parse arguments
const USE_AI = process.argv.includes('--ai') || process.argv.includes('--use-ai');
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const networksPathArg = process.argv.find(arg => arg.startsWith('--networks-path='));
const NETWORKS_PATH = networksPathArg ? networksPathArg.split('=')[1] : './otim-protocol/.github/networks';

// Format contract name from EXPECTED_*_ADDRESS key
function formatContractName(key) {
  return key
    .replace(/^EXPECTED_|_ADDRESS$/g, '')
    .replace(/_/g, ' ')
    .toLowerCase()
    .split(' ')
    .map(word => {
      if (word === 'erc20') return 'ERC20';
      if (word === 'cctp') return 'CCTP';
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join('');
}

// Extract addresses from file using basic (non-AI) extraction method
function extractAddressesFromFileBasic(filePath) {
  if (!fs.existsSync(filePath)) return '';
  
  const content = fs.readFileSync(filePath, 'utf8');
  const matches = content.match(/^EXPECTED_[A-Z0-9_]+_ADDRESS=(.+)$/gm) || [];
  const regexMatches = matches.map(line => line.match(/^(EXPECTED_[A-Z0-9_]+_ADDRESS)=(.+)$/));
  const filtered = regexMatches.filter(match => match && match[2].trim());
  
  const addresses = filtered.map(match => ({
    name: formatContractName(match[1]),
    address: match[2].trim()
  })).sort((a, b) => a.name.localeCompare(b.name));
  
  if (addresses.length === 0) return '';
  
  const tableRows = addresses.map(addr => `| \`${addr.name}\` | \`${addr.address}\` |`).join('\n');
  return `| Name | Address |\n| :--- | :--- |\n${tableRows}`;
}

// Extract addresses from file using AI extraction method
async function extractAddressesFromFileAI(filePath) {
  if (!fs.existsSync(filePath)) return '';
  
  const content = fs.readFileSync(filePath, 'utf8');
  if (!/^EXPECTED_[A-Z0-9_]+_ADDRESS=/m.test(content)) return '';

  const prompt = `Extract EXPECTED_*_ADDRESS variables with non-empty values. Return JSON only:
{
  "EXPECTED_CONTRACT_NAME_ADDRESS": "0x...",
  "EXPECTED_ANOTHER_CONTRACT_ADDRESS": "0x..."
}
${content}`;

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: "system", content: "You are a smart contract address extractor. Extract addresses from environment files and return them as JSON." },
          { role: "user", content: prompt }
        ],
        max_tokens: 2000,
        temperature: 0.1
      })
    });

    if (!response.ok) throw new Error(`API request failed: ${response.status}`);

    const data = await response.json();
    const aiOutput = data.choices[0].message.content.trim();
    
    // Parse JSON and format using same logic as basic method
    const addresses = JSON.parse(aiOutput);
    const formattedAddresses = Object.entries(addresses)
      .filter(([key, value]) => value && value.trim())
      .map(([key, value]) => ({
        name: formatContractName(key),
        address: value.trim()
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    
    if (formattedAddresses.length === 0) return '';
    
    const tableRows = formattedAddresses.map(addr => `| \`${addr.name}\` | \`${addr.address}\` |`).join('\n');
    return `| Name | Address |\n| :--- | :--- |\n${tableRows}`;
    
  } catch (error) {
    return extractAddressesFromFileBasic(filePath);
  }
}

// Process network environment files
function processNetwork(networkType, coreFile, excludeFiles, networksPath = NETWORKS_PATH) {
  const dir = `${networksPath}/${networkType}/`;
  const coreFilePath = `${networksPath}/${networkType}/${path.basename(coreFile)}`;
  
  const files = [coreFilePath, ...fs.readdirSync(dir)
    .filter(file => file.startsWith('.env-') && !excludeFiles.includes(file))
    .map(file => path.join(dir, file))];

  return files.map((file, i) => ({
    file,
    chainName: i === 0 ? 'Core Contracts' : path.basename(file)
      .replace('.env-', '')
      .replace(/-/g, ' ')
      .replace(/\b\w/g, l => l.toUpperCase()),
    networkType
  }));
}

// Generate Deployed Addresses MDX output
async function generateMDXOutput(allFiles, useAI) {
  const extract = useAI ? extractAddressesFromFileAI : extractAddressesFromFileBasic;
  
  const mainnet = allFiles.filter(f => f.networkType === 'mainnet');
  const testnet = allFiles.filter(f => f.networkType === 'testnet');
  
  // Identify Core Contracts
  const coreMainnet = mainnet.find(f => f.chainName === 'Core Contracts');
  const coreTestnet = testnet.find(f => f.chainName === 'Core Contracts');
  
  // Identify chain specific contracts
  const mainnetChains = mainnet.filter(f => f.chainName !== 'Core Contracts');
  const testnetChains = testnet.filter(f => f.chainName !== 'Core Contracts');

  // Generate MDX output
  const addTabs = async (chains, title) => {
    if (chains.length === 0) return '';
    const tabs = await Promise.all(chains.map(async chain => {
      const content = await extract(chain.file);
      return content ? `  <Tab title="${chain.chainName}">\n${content}\n  </Tab>` : '';
    }));
    return `### ${title}\n\n<Tabs>\n${tabs.filter(Boolean).join('\n')}\n</Tabs>\n\n`;
  };

  const mainnetTabs = await addTabs(mainnetChains, 'Mainnet');
  const testnetTabs = await addTabs(testnetChains, 'Testnet');
  
  return `---
title: "Deployed Addresses"
sidebarTitle: "Deployed Addresses"
---
<Tabs>
${coreMainnet ? `  <Tab title="Core Mainnet">
${await extract(coreMainnet.file)}
  </Tab>` : ''}
${coreTestnet ? `  <Tab title="Core Testnet">
${await extract(coreTestnet.file)}
  </Tab>` : ''}
</Tabs>

${mainnetTabs}${testnetTabs}`;
}

async function main() {
  if (USE_AI && !OPENAI_API_KEY) {
    console.error('Error: OPENAI_API_KEY environment variable is required for AI method');
    process.exit(1);
  }

  const mainnetFiles = processNetwork('mainnet', '.github/networks/mainnet/.env-otim-mainnet', ['.env-otim-mainnet']);
  const testnetFiles = processNetwork('testnet', '.github/networks/testnet/.env-otim-testnet', ['.env-otim-testnet']);
  const allFiles = [...mainnetFiles, ...testnetFiles];

  const mdxOutput = await generateMDXOutput(allFiles, USE_AI);
  fs.writeFileSync('docs/developers/deployed-addresses.mdx', mdxOutput);
}

main().catch(console.error);
