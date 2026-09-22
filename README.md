# Silent Payment Indexer

A service that simplifies receiving Bitcoin silent payments for wallets and applications.

> [!WARNING]
> This application is currently in an experimental stage and should be used with caution. It has not undergone extensive testing and may contain bugs, vulnerabilities, or unexpected behavior. Mainnet use is strictly NOT recommended.

## :ledger: Table of Contents

- [Silent Payment Indexer](#silent-payment-indexer)
  - [:ledger: Table of Contents](#ledger-table-of-contents)
  - [:beginner: About](#beginner-about)
  - [:station: Features](#station-features)
  - [:electric\_plug: Installation](#electric_plug-installation)
    - [:notebook: Prerequisites](#notebook-prerequisites)
    - [:wrench: Configuration](#wrench-configuration)
      - [Option 1: Using Polar (Recommended)](#option-1-using-polar-recommended)
      - [Option 2: Using Docker Compose](#option-2-using-docker-compose)
      - [Option 3: Manual Bitcoin Core Installation](#option-3-manual-bitcoin-core-installation)
    - [:rocket: Running the Application](#rocket-running-the-application)
    - [:bug: Troubleshooting](#bug-troubleshooting)
  - [:file\_folder: File Structure](#file_folder-file-structure)
    - [src Directory Structure](#src-directory-structure)
  - [:cherry\_blossom: Community](#cherry_blossom-community)
    - [:fire: Contribution](#fire-contribution)
  - [:wrench: Experimental Warning](#wrench-experimental-warning)

## :beginner: About

Silent Payment Indexer is a service designed to efficiently index and organize Bitcoin silent payment data, simplifying the process of receiving silent payments for wallets and applications. By providing a reliable and performant indexing solution, this project aims to also accelerate the adoption of silent payments on the Bitcoin network.

Read more about silent payments in [BIP 352](https://github.com/bitcoin/bips/pull/1458) and [Ruben Somsen's post](https://gist.github.com/RubenSomsen/c43b79517e7cb701ebf77eec6dbb46b8).

## :station: Features

-   **Efficient Indexing:** Processes Bitcoin blocks to extract silent payment data.
-   **Structured Data Storage:** Stores indexed data for easy retrieval.
-   **API Queries:** Enables applications to search for specific silent payment information.
-   **Continuous Updates:** Maintains data freshness by indexing new blocks.

## :electric_plug: Installation

1. Clone the repository:

```bash
  $ git clone https://github.com/Bitshala-Incubator/silent-pay-indexer.git
```

2. Navigate to the project directory:

```bash
  $ cd silent-pay-indexer
```

3. Install dependencies:

```bash
  $ npm install
```

> **Note:** If you encounter `gyp` or `sqlite3` build errors, please check your Node.js version. Proceeding with Node.js v18 or v20 LTS is recommended to use prebuilt binaries.

### :notebook: Prerequisites

-   **Node.js** (v18 or v20 LTS recommended. Newer versions like v22 may fail to install `sqlite3` without C++ build tools)
-   **Bitcoin Node** - Choose one:
    -   [Polar](https://lightningpolar.com/) (Recommended - easiest setup)
    -   Docker (see setup instructions below)
    -   Bitcoin Core (manual installation)

### :wrench: Configuration

#### Option 1: Using Polar (Recommended)

[Polar](https://lightningpolar.com/) is a one-click Bitcoin and Lightning network for local development with a visual interface.

1. **Download and Install Polar**
   - Visit https://lightningpolar.com/
   - Download and install for your operating system
   - Launch Polar

2. **Create a Bitcoin Network**
   - Open Polar and click **"Create Network"**
   - Set **Network Name**: `silent-pay-dev` (or any name)
   - Set **Bitcoin Nodes**: `1`
   - Set **Lightning Nodes**: `0` (not needed)
   - Click **"Create Network"**

3. **Start the Network**
   - Click the **Start** button (▶) in Polar
   - Wait for the Bitcoin node to turn green (running)
   - Click on the Bitcoin node to view RPC credentials

4. **Get RPC Credentials**
   - In Polar, select your Bitcoin Core node
   - Find the **Connect/Info/RPC** tab
   - Note the credentials:
     - RPC Host: `localhost` or `127.0.0.1`
     - RPC Port: `18443` (regtest default)
     - RPC User: (shown in Polar, usually `polaruser`)
     - RPC Password: (shown in Polar, usually `polarpass`)

5. **Mine Initial Blocks**
   - In Polar, click **"Mine Blocks"**
   - Enter `100` blocks
   - Click **"Mine"** to create blockchain data

6. **Create Development Config**

```bash
$ cd config
$ cp example.config.yaml dev.config.yaml
```

Update `config/dev.config.yaml` with your Polar credentials:

```yaml
db:
  path: '~/.silent-pay-indexer/db/database.sqlite'
  synchronize: true  # Auto-create tables in dev mode

app:
  port: 80
  verbose: false
  debug: true
  network: regtest  # Must match Polar (regtest)
  requestRetry:
    delay: 500
    count: 3

providerType: BITCOIN_CORE_RPC

bitcoinCore:
  protocol: http
  rpcHost: 127.0.0.1          # No http:// prefix!
  rpcPass: polarpass           # From Polar UI
  rpcUser: polaruser           # From Polar UI
  rpcPort: 18443               # From Polar UI

throttler:
  ttl: 1000
  limit: 5

cache:
  ttl: 5000
```

**Important Notes:**
- `rpcHost` should be just the hostname (`127.0.0.1`), NOT the full URL
- `dev.config.yaml` is in `.gitignore` - it's machine-specific
- Verify credentials match what Polar displays

#### Option 2: Using Docker Compose

1. **Start Bitcoin Core with Docker**

```bash
$ docker compose -f "./e2e/helpers/docker/docker-compose.yml" up -d
```

This starts a Bitcoin Core regtest node with:
- RPC Port: `18443`
- RPC User: `polaruser`
- RPC Password: `password`

2. **Create Development Config**

```bash
$ cd config
$ cp example.config.yaml dev.config.yaml
```

Update `config/dev.config.yaml`:

```yaml
db:
  path: '~/.silent-pay-indexer/db/database.sqlite'
  synchronize: true

app:
  port: 80
  network: regtest
  # ... other settings

providerType: BITCOIN_CORE_RPC

bitcoinCore:
  protocol: http
  rpcHost: 127.0.0.1
  rpcPass: password      # Docker default
  rpcUser: polaruser     # Docker default
  rpcPort: 18443
```

3. **Verify Bitcoin Node is Running**

```bash
$ docker ps
```

You should see `silent-pay-bitcoind` container running.

#### Option 3: Manual Bitcoin Core Installation

1. Download Bitcoin Core from https://bitcoincore.org/
2. Create `bitcoin.conf` in your Bitcoin data directory:

```ini
regtest=1
server=1
rpcuser=youruser
rpcpassword=yourpassword
rpcport=18443
rpcallowip=127.0.0.1
txindex=1
```

3. Start Bitcoin Core with `-regtest` flag
4. Update `config/dev.config.yaml` with your credentials

### :rocket: Running the Application

1. **Ensure Bitcoin Node is Running**
   - Polar: Network should be started (green status)
   - Docker: Container should be running
   - Manual: Bitcoin Core should be running with `-regtest`

2. **Start the Indexer**

```bash
$ npm run start:dev
```

3. **Verify It's Working**
   - Check logs for successful startup
   - Visit `http://localhost/api` for API documentation
   - Visit `http://localhost/silent-block/latest-height` to check indexed blocks

4. **Mine More Blocks (Optional)**
   - In Polar: Use the "Mine Blocks" button
   - With Docker: 
     ```bash
     $ docker exec silent-pay-bitcoind bitcoin-cli -regtest -rpcuser=polaruser -rpcpassword=password generatetoaddress 10 <address>
     ```

### :bug: Troubleshooting

**Error: `ECONNREFUSED` to localhost:18443**
- ✅ Ensure Bitcoin node is running (check Polar/Docker)
- ✅ Verify `rpcHost` is `127.0.0.1` (no protocol prefix)
- ✅ Verify `rpcPort`, `rpcUser`, and `rpcPass` match your node

**Error: `SqliteError: no such table`**
- ✅ Set `db.synchronize: true` in `config/dev.config.yaml`
- ✅ Delete database and restart: `rm -rf ~/.silent-pay-indexer/db/`

**Error: `gyp ERR!` during npm install**
- ✅ Use Node.js v18 or v20 LTS (not v22+)
- ✅ Install build tools (Windows: Visual Studio Build Tools)

**Port 80 already in use**
- ✅ Change `app.port` to `3000` in config
- ✅ Or use: `APP_PORT=3000 npm run start:dev`

## :file_folder: File Structure

This is a basic overview of the project structure, it reflects the main components of the silent payment indexer application. The `src` directory is further divided into subdirectories based on the different functionalities of the application.

```console
├── config
├── docs
├── dev
├── src
│   ├── block-data-providers
│   ├── common
│   ├── indexer
│   ├── operation-state
│   ├── transactions
│       ├── controller.ts
│       ├── service.ts
│   ├── controller.ts
│   └── configuration.ts
│   └── main.ts
```

| Directory/File | Description                                                |
| -------------- | ---------------------------------------------------------- |
| **`config`**   | Stores configuration files for the project                 |
| **`dev   `**   | Contains development-specific files (e.g., Docker Compose) |
| **`docs  `**   | Contains documentation files (e.g., design.md)             |
| **`src   `**   | Contains the source code for the application               |

### src Directory Structure

| Directory/File             | Description                                                                       |
| -------------------------- | --------------------------------------------------------------------------------- |
| **`block-data-providers`** | Contains logic for fetching data from different block data providers periodically |
| **`common`**               | Contains shared utility functions and constants                                   |
| **`indexer`**              | Contains the core logic for indexing silent payments                              |
| **`operation-state`**      | Handles the state of indexing operations                                          |
| **`transactions`**         | Handles transaction-related logic and API querying requests                       |
| **`configuration`**        | Handles project configuration                                                     |

## :cherry_blossom: Community

The dev community lurks in a small corner of Discord [here](https://discord.gg/Rfyp2nRGj7) (say 👋, if you drop there from this readme).

Dev discussions predominantly happen via FOSS best practices, and by using Github as the Community Forum.

### :fire: Contribution

We welcome and encourage contributions to this actively developed project! For details on contributing, please refer to [CONTRIBUTING.md](CONTRIBUTING.md).

Few directions for new contributors:

-   The list of [issues](https://github.com/Bitshala-Incubator/silent-pay-indexer/issues) is a good place to look for contributable tasks and open problems.

-   Issues marked with [`good first issue`](https://github.com/Bitshala-Incubator/silent-pay-indexer/issues?q=is%3Aopen+is%3Aissue+label%3A%22good+first+issue%22) are good places to get started.

-   Tests are a good place to start gathering a contextual understanding of the codebase.

-   Reviewing [open PRs](https://github.com/Bitshala-Incubator/silent-pay-indexer/pulls) are a good place to understand the codebase and the contribution process.

## :wrench: Experimental Warning

This service is experimental and under active development. By using it, you acknowledge the following:

1. **Risk of Loss of Funds:** Using this service may result in the loss of your funds. You should be aware that any funds you use with this service are at risk and could become inaccessible or irretrievable.
2. **No Guarantee of Performance:** The service may not perform as expected and may lead to unintended outcomes, including data loss, loss of funds, or other adverse effects.
3. **No Warranty:** There is no warranty provided for this service. It is distributed "as is" without any guarantees of functionality, security, or reliability.
4. **Security Considerations:** This service may contain security vulnerabilities or weaknesses that could expose your data or funds to risks. You are responsible for conducting your own security assessments and risk evaluations.
5. **Limited Documentation:** The documentation for this service may be incomplete, inaccurate, or outdated.
6. **API and Compatibility Changes:** This code is subject to frequent changes, including modifications to its API, features, or compatibility with other software. These changes may affect your ability to use the service effectively.

We strongly recommend using this service for testing and development purposes only.

**Use it at your own risk.**
