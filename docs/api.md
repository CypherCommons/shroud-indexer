# Silent Payments Indexer HTTP API

## Transactions

### `GET '/transactions/blockHeight/:blockHeight'`

Returns an array of transactions from the block height.

### `GET '/transactions/blockHash/:blockHash'`

Returns an array of transactions from the block hash.

## Silent Block

### `GET '/silent-block/blockHeight/:blockHeight'`

Returns a serialized silent block from the block height.

### `GET '/silent-block/blockHash/:blockHash'`

Returns a serialized silent block from the block hash.

## Transaction Format

The following fields are included in the transaction format:

- `id`
- `blockHeight`
- `blockHash`
- `scanTweak`
- `outputs[]`
  - `pubKey`
  - `value`
  - `vout`
- `isSpent`


## Example

The following `curl` request fetches transactions by block hash:

```bash
curl -X GET http://localhost:3000/transactions/blockHash/0c7e0300e581659ee33fe0b8f6b26a7143642aaf34969e42a5851c46678c79fe | jq .

{
  "transactions": [
    {
      "id": "f16cd147e7a07af95c2f8e3ad2d20a5c067ad117b147c715533e297af0ba13ef",
      "blockHeight": 201,
      "blockHash": "0c7e0300e581659ee33fe0b8f6b26a7143642aaf34969e42a5851c46678c79fe",
      "scanTweak": "03afd16fb34f2e326c22ab83adac3ca077b870d56078d582f8ab129cad773082ef",
      "outputs": [
        {
          "pubKey": "cd7efeee8e320915f4180f5c9d92d8bf6a6b63ec2b13b4cfda2f8660959b9e11",
          "value": 599900000,
          "vout": 0
        }
      ],
      "isSpent": false
    }
  ]
}
