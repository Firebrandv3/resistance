'use strict'

/* global sessionStorage, alert */

import React from 'react'
import PageLayout from '../components/PageLayout.js'
import PageHeader from '../components/PageHeader.js'
import io from 'socket.io-client'
import Router from 'next/router'
import PlayerLobby from '../components/PlayerLobby.js'

export default class Game extends React.Component {
  constructor (props) {
    super(props)
    this.state = {
      header: <h1 className='display-4'>Waiting for players</h1>,
      show: [],
      gameInProgress: false,
      gameCode: '',
      players: []
    }
    this.socketEmmitter = this.socketEmmitter.bind(this)
  }
  handleUnload (e) {
    e.preventDefault()
    e.returnValue = ''
  }
  socketEmmitter (event, message) {
    this.socket.emit(event, message)
  }
  componentDidMount () {
    if (sessionStorage.authKey) {
      this.player = JSON.parse(sessionStorage.authKey)
      this.setState({
        gameCode: this.player.gameCode
      })

      this.socket = io()

      this.socket.on('connect', () => {
        this.socket.emit('authRequest', this.player)
      })

      this.socket.on('myError', error => {
        console.error(error)
        alert(error.message)
        if (error.type === 'authError') {
          sessionStorage.removeItem('authKey')
          Router.push('/')
        }
      })

      this.socket.on('gameStatus', status => {
        if (!status.playing) {
          this.setState({
            players: status.players,
            gameInProgress: false
          })
        }
      })

      this.socket.on('nameChanged', msg => {
        this.player.name = msg.newName
        sessionStorage.authKey = JSON.stringify(this.player)
      })

      this.socket.on('kicked', () => {
        sessionStorage.removeItem('authKey')
        Router.push('/')
      })

      window.addEventListener('beforeunload', this.handleUnload)
    } else {
      Router.push('/')
    }
  }
  componentWillUnmount () {
    if (this.socket) {
      this.socket.disconnect()
      delete this.socket
    }
    window.removeEventListener('beforeunload', this.handleUnload)
  }
  render () {
    return (
      <PageLayout title='Resistance'>
        <PageHeader>{this.state.header}</PageHeader>
        <PlayerLobby
          hidden={this.state.gameInProgress}
          gameCode={this.state.gameCode}
          players={this.state.players}
          myPlayer={this.player}
          socketEmmitter={this.socketEmmitter}
        />

      </PageLayout>
    )
  }
}
