'use strict'

const server = require('express')()
const http = require('http').createServer(server)
const io = require('socket.io')(http)
const next = require('next')
const bodyParser = require('body-parser')
const crypto = require('crypto')
const MongoClient = require('mongodb').MongoClient

const dev = process.env.NODE_ENV !== 'production'
const app = next({ dev })
const handle = app.getRequestHandler()

const maxGameCode = 1000000 // noninclusive
const minGameCode = 0 // inclusive
const mongoUrl = 'mongodb://localhost:27017'

class UserException extends Error {
  constructor (message, type) {
    super(message)
    this.message = message
    this.name = 'UserException'
    this.type = type || ''
  }
  toString () {
    return `Error: ${this.message}`
  }
  toJSON () {
    return {
      name: this.name,
      message: this.message,
      type: this.type
    }
  }
}

function randomBytesHexAsync (size) {
  return new Promise((resolve, reject) => {
    crypto.randomBytes(size, (err, buf) => {
      if (err) {
        reject(err)
      } else {
        resolve(buf.toString('hex'))
      }
    })
  })
}

function handleSocketError (e, socket) {
  if (e instanceof UserException) {
    socket.emit('myError', e)
  } else {
    console.error(e)
    socket.emit('myError', new UserException('An unexpected error occurred'))
  }
}

async function createGame (db, gamesCollection) {
  // Creates game and returns the code
  if (await gamesCollection.countDocuments() > 100000) {
    throw new Error('There are too many games in progress to start a new one.')
  }
  let gameCode
  do {
    gameCode = (
      Math.floor(Math.random() * (maxGameCode - minGameCode)) + minGameCode
    )
  } while (await gamesCollection.findOne({ code: gameCode }))
  await Promise.all([
    db.db('game-' + gameCode).collection('status').insertOne({
      playing: false,
      lastSignificantChange: new Date()
      // Significant changes are creating game, strating round, ending round
    }),
    gamesCollection.insertOne({
      code: gameCode
    })
  ])
  return gameCode
}

async function joinGame (db, name, gameCode, gamesCollection) {
  const gameDb = db.db('game-' + gameCode)

  const validationDocs = await Promise.all([
    gamesCollection.findOne({ code: parseInt(gameCode) }),
    gameDb.collection('status').findOne({}),
    gameDb.collection('players').findOne({ name: name }),
    gameDb.collection('players').find({}).toArray()
  ])
  if (!validationDocs[0]) {
    throw new UserException(`The game ${gameCode} does not exist.`)
  } else if (validationDocs[1].playing !== false) {
    throw new UserException('Cannot join game. It is currently in progress.')
  } else if (validationDocs[2]) {
    throw new UserException(
      'Your chosen name is in use by another player. Please use another name.')
  } else if (validationDocs[3].length >= 10) {
    throw new UserException('There are already 10 players in this game')
  }

  const key = await randomBytesHexAsync(32)
  const hash = crypto.createHash('sha256')
  hash.update(key)
  await gameDb.collection('players').insertOne({
    name: name,
    order: validationDocs[3].length + 1,
    hashedKey: hash.digest('hex')
  })

  return {
    gameCode: gameCode,
    name: name,
    key: key
  }
}

async function authUser (db, socketClientId, authKey) {
  const gamesCollection = db.db('games').collection('games')
  const query = { code: parseInt(authKey.gameCode) }
  if (!(await gamesCollection.findOne(query))) {
    throw new UserException(
      'The game you are trying to enter does not exist',
      'authError'
    )
  }
  const gameDb = db.db('game-' + authKey.gameCode)
  const player = await gameDb.collection('players').findOne({
    name: authKey.name
  })
  if (!player) {
    throw new UserException(
      'You have not yet joined the game properly',
      'authError'
    )
  }
  await gameDb.collection('players').updateOne(query, {
    $set: {
      socketClientId: socketClientId
    }
  })
  const hash = crypto.createHash('sha256')
  hash.update(authKey.key)
  if (hash.digest('hex') === player.hashedKey) {
    return {
      authenticated: true,
      name: authKey.name,
      gameCode: authKey.gameCode
    }
  } else {
    throw new UserException('Unauthorized', 'authError')
  }
}

async function getGameStatus (gameDb) {
  try {
    const gameInfo = await Promise.all([
      gameDb.collection('status').findOne({}),
      gameDb.collection('players').find({}).toArray()
    ])
    if (!gameInfo[0].playing) {
      const players = gameInfo[1].map(player => ({
        name: player.name,
        order: player.order,
        gameCode: player.gameCode
      }))
      return {
        playing: false,
        players: players
      }
    }
  } catch (e) {
    console.error(e)
    return {
      error: new Error('An unexpected error occurred')
    }
  }
}

async function changeName (gameDb, currentName, newName) {
  if (currentName === newName) {
    throw new UserException('You entered the same name as your current name')
  } else if (newName === '') {
    throw new UserException('You cannot have a blank name')
  }
  const status = await gameDb.collection('status').findOne({})
  if (status.playing) {
    throw new UserException('Cannot changle player name while game in progress')
  }
  const query = { name: currentName }
  const mongoPlayer = await gameDb.collection('players').findOne(query)
  if (!mongoPlayer) {
    throw new UserException('Your current player does not exist')
  }
  await gameDb.collection('players').updateOne(query, {
    $set: {
      name: newName
    }
  })
  return newName
}

async function removePlayer (db, gameDb, playerToRemove) {
  const mongoCommands = await Promise.all([
    gameDb.collection('status').findOne({}),
    gameDb.collection('players').findOne({
      name: playerToRemove.name
    })
  ])
  const status = mongoCommands[0]
  const playerToRemoveMongo = mongoCommands[1]
  if (status.playing) {
    throw new UserException('Cannot remove player while game in progress')
  } else if (!playerToRemoveMongo) {
    throw new UserException('The player you try to remove is not in game')
  }
  await gameDb.collection('players').deleteOne({ name: playerToRemove.name })
  const players = await gameDb.collection('players').find({}).toArray()
  if (players.length === 0) {
    await Promise.all([
      gameDb.dropDatabase(),
      db.db('games').collection('games').deleteOne({
        code: playerToRemove.gameCode
      })
    ])
  }
  return {
    playerToRemove: playerToRemove,
    socketClientId: playerToRemoveMongo.socketClientId
  }
}

async function runApp () {
  try {
    await app.prepare()

    server.use(bodyParser.urlencoded({ extended: false }))
    server.use(bodyParser.json())

    const db = await MongoClient.connect(mongoUrl, { useNewUrlParser: true })

    server.get('*', (req, res) => {
      return handle(req, res)
    })

    // create or join game
    server.post('/join', async (req, res) => {
      try {
        const { playerName } = req.body
        let { gameCode } = req.body
        const gamesCollection = db.db('games').collection('games')

        // Validate playerName
        if (playerName == null || playerName === '') {
          throw new UserException('Must enter a name')
        } else if (playerName.length > 20) {
          throw new UserException('Max name length is 20 characters')
        }

        // Validate gameCode
        if (gameCode != null && (gameCode < minGameCode ||
            gameCode >= maxGameCode)) {
          throw new UserException(`Game code must be integer between
                ${minGameCode} (inclusive) and ${maxGameCode} (exclusive).`)
        }

        // Create game if doesn't exist
        if (gameCode == null) {
          gameCode = await createGame(db, gamesCollection)
        }

        // Join game, send name and key to client
        res.json(await joinGame(db, playerName, gameCode, gamesCollection))
      } catch (e) {
        if (e instanceof UserException || dev) {
          res.json({ error: e })
          if (!(e instanceof UserException)) {
            console.error(e)
          }
        } else {
          res.status(500).json({
            error: new Error(
              'An unexpected error occurred while processing your request'
            )
          })
          console.error(e)
        }
      }
    })

    // Delete game after certain amount of time
    const msToLive = process.env.NODE_ENV === 'production' ? 86400000 : 1800000
    setInterval(async () => {
      try {
        const gamesCollection = db.db('games').collection('games')
        const games = await gamesCollection.find({}).toArray()
        const gameStatuses = await Promise.all(
          Array.from(games, game => new Promise(async (resolve, reject) => {
            try {
              const statusCollection = (
                await db.db('game-' + game.code).collection('status').findOne({})
              )
              resolve({
                code: game.code,
                status: statusCollection
              })
            } catch (e) {
              reject(e)
            }
          }))
        )
        let dropCommands = []
        const currentDate = new Date()
        gameStatuses.forEach(game => {
          const shouldDie = (!game.status ||
            currentDate - game.status.lastSignificantChange > msToLive)
          if (shouldDie) {
            dropCommands.push(db.db('game-' + game.code).dropDatabase())
            dropCommands.push(gamesCollection.deleteOne({ code: game.code }))
            console.log('Deleted game ' + game.code)
          }
        })
        await Promise.all(dropCommands)
      } catch (e) {
        console.error(e)
      }
    }, msToLive)

    io.on('connection', socket => {
      let player = {
        authenticated: false
      }
      let gameDb, roomAll

      socket.on('authRequest', async authKey => {
        try {
          const authReply = await authUser(db, socket.client.id, authKey)
          player = authReply
          gameDb = db.db('game-' + player.gameCode)
          const roomAllName = `game-${player.gameCode}-all`
          socket.join(roomAllName)
          roomAll = io.to(roomAllName)
          roomAll.emit('gameStatus', await getGameStatus(gameDb))
        } catch (e) {
          handleSocketError(e, socket)
        }
      })

      socket.on('changeName', async msg => {
        if (player.authenticated) {
          try {
            player.name = await changeName(gameDb, player.name, msg.newName)
            socket.emit('nameChanged', msg)
            roomAll.emit('gameStatus', await getGameStatus(gameDb))
          } catch (e) {
            handleSocketError(e, socket)
          }
        }
      })

      socket.on('removalRequest', async playerToRemove => {
        if (player.authenticated) {
          try {
            const result = await removePlayer(db, gameDb, playerToRemove)
            io.to(result.socketClientId).disconnect()
            roomAll.emit('removedPlayer', result.playerToRemove)
            roomAll.emit('gameStatus', await getGameStatus(gameDb))
          } catch (e) {
            handleSocketError(e, socket)
          }
        }
      })
    })

    http.listen(process.env.PORT || 3000, err => {
      if (err) throw err
      console.log('> Ready on http://localhost:3000')
    })
  } catch (e) {
    console.error(e.stack)
    process.exit(1)
  }
}

runApp()
